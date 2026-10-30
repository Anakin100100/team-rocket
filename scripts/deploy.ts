import { spawnSync } from "node:child_process";
import type { SpawnSyncOptions } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseEnv } from "node:util";

const ROOT = path.resolve(import.meta.dirname, "..");
const VALID_ENVIRONMENTS = new Set(["preview", "production"]);
const DEFAULT_ENVIRONMENT = "preview";
// Vercel Services needs a recent CLI; an outdated global install can't deploy it.
const VERCEL_COMMAND = ["bunx", "vercel@latest"] as const;
// Values the server's .env.schema requires that Vercel doesn't provide itself.
const REQUIRED_KEYS = ["BETTER_AUTH_SECRET", "DATABASE_URL", "RESEND_API_KEY"];
const HEALTH_CHECK_PATH = "/api/rpc/healthCheck";
const HEALTH_CHECK_OK = '"json":"OK"';
const HEALTH_CHECK_ATTEMPTS = 3;
const HEALTH_CHECK_RETRY_MS = 5000;

const USAGE = `Usage: tsx scripts/deploy.ts [preview|production] [--skip-checks] [--skip-db] [-- <vercel deploy flags>]

  --skip-checks  Skip lint and type checks
  --skip-db      Skip pushing the Drizzle schema (production only)`;

const args = process.argv.slice(2);
const separatorIndex = args.indexOf("--");
const scriptArgs = separatorIndex === -1 ? args : args.slice(0, separatorIndex);
const forwardedArgs =
  separatorIndex === -1 ? [] : args.slice(separatorIndex + 1);

if (scriptArgs.includes("--help") || scriptArgs.includes("-h")) {
  console.log(USAGE);
  process.exit(0);
}

const positional = scriptArgs.filter((arg) => !arg.startsWith("-"));
const environment = positional[0] ?? DEFAULT_ENVIRONMENT;
if (!VALID_ENVIRONMENTS.has(environment) || positional.length > 1) {
  console.error(USAGE);
  process.exit(1);
}
const isProduction = environment === "production";
const skipChecks = scriptArgs.includes("--skip-checks");
const skipDb = scriptArgs.includes("--skip-db");

const run = (
  command: string,
  commandArgs: readonly string[],
  options: SpawnSyncOptions = {}
) => {
  const result = spawnSync(command, commandArgs, {
    cwd: ROOT,
    stdio: "inherit",
    encoding: "utf-8",
    // Windows resolves bunx/npx/pnpm via .cmd shims, which need a shell
    shell: process.platform === "win32",
    ...options,
  });
  if (result.error) {
    console.error(`Failed to run ${command}: ${result.error.message}`);
    process.exit(1);
  }
  return result;
};

const runOrExit = (
  label: string,
  command: string,
  commandArgs: readonly string[],
  options: SpawnSyncOptions = {}
) => {
  const result = run(command, commandArgs, options);
  if (result.status !== 0) {
    console.error(`${label} failed.`);
    process.exit(result.status ?? 1);
  }
  return result;
};

const vercel = (
  commandArgs: readonly string[],
  options: SpawnSyncOptions = {}
) =>
  run(VERCEL_COMMAND[0], [...VERCEL_COMMAND.slice(1), ...commandArgs], options);

// CLI JSON output can be preceded by bunx's install progress.
const parseJsonOutput = (output: string): unknown =>
  JSON.parse(output.slice(output.indexOf("{")));

const step = (message: string) => console.log(`\n▸ ${message}`);

const ensureLinked = () => {
  if (!existsSync(path.join(ROOT, ".vercel", "project.json"))) {
    console.error(
      "This repo isn't linked to a Vercel project. Run `bun run deploy:setup` first."
    );
    process.exit(1);
  }
};

const ensureEnvVars = () => {
  const result = vercel(["env", "ls", environment, "--json"], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (result.status !== 0) {
    console.error("Could not list Vercel environment variables.");
    process.exit(result.status ?? 1);
  }
  const { envs } = parseJsonOutput(String(result.stdout)) as {
    envs: { key: string }[];
  };
  const keys = new Set(envs.map(({ key }) => key));
  const missing = REQUIRED_KEYS.filter((key) => !keys.has(key));
  if (missing.length > 0) {
    console.error(
      `Missing Vercel ${environment} env var(s): ${missing.join(", ")}. Add them with \`vercel env add <KEY> ${environment}\` or \`bun run env:${environment}\`.`
    );
    process.exit(1);
  }
};

// The Neon integration shares one database across Vercel environments, so the
// schema is only pushed on production deploys. drizzle-kit prompts before any
// destructive change, so this needs an interactive terminal when one occurs.
const pushSchema = () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "rocket-deploy-"));
  const envFile = path.join(tempDir, ".env");
  try {
    const pull = vercel(
      ["env", "pull", envFile, "--environment", environment, "--yes"],
      { stdio: ["ignore", "ignore", "inherit"] }
    );
    if (pull.status !== 0) {
      console.error("Could not pull Vercel environment variables.");
      process.exit(pull.status ?? 1);
    }
    const pulled = parseEnv(readFileSync(envFile, "utf-8"));
    // Schema changes need a direct connection, not Neon's pooler.
    const databaseUrl = pulled.DATABASE_URL_UNPOOLED ?? pulled.DATABASE_URL;
    if (!databaseUrl) {
      console.error(`DATABASE_URL is empty in the Vercel ${environment} env.`);
      process.exit(1);
    }
    runOrExit("Schema push", "bun", ["run", "db:push"], {
      cwd: path.join(ROOT, "packages", "db"),
      env: { ...process.env, DATABASE_URL: databaseUrl },
    });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
};

const deploy = () => {
  const result = vercel(
    [
      "deploy",
      ...(isProduction ? ["--prod"] : []),
      "--yes",
      "--json",
      ...forwardedArgs,
    ],
    { stdio: ["inherit", "pipe", "inherit"] }
  );
  if (result.status !== 0) {
    console.error("Deployment failed.");
    process.exit(result.status ?? 1);
  }
  const output = parseJsonOutput(String(result.stdout)) as {
    url?: string;
    deployment?: { url?: string };
  };
  const url = output.deployment?.url ?? output.url;
  if (!url) {
    console.error("Deployment finished but its URL was not reported.");
    process.exit(1);
  }
  return url.startsWith("http") ? url : `https://${url}`;
};

const isHealthy = (deploymentUrl: string) => {
  const result = vercel(
    [
      "curl",
      HEALTH_CHECK_PATH,
      "--deployment",
      deploymentUrl,
      "--yes",
      "--",
      "--silent",
      "--request",
      "POST",
      "--header",
      "content-type: application/json",
      "--data",
      "{}",
    ],
    { stdio: ["ignore", "pipe", "ignore"] }
  );
  return result.status === 0 && String(result.stdout).includes(HEALTH_CHECK_OK);
};

const waitForHealthy = async (
  deploymentUrl: string,
  attemptsLeft = HEALTH_CHECK_ATTEMPTS
): Promise<boolean> => {
  if (isHealthy(deploymentUrl)) {
    return true;
  }
  if (attemptsLeft <= 1) {
    return false;
  }
  await sleep(HEALTH_CHECK_RETRY_MS);
  return waitForHealthy(deploymentUrl, attemptsLeft - 1);
};

console.log(`Deploying to Vercel ${environment}.`);
ensureLinked();

if (skipChecks) {
  step("Skipping lint and type checks");
} else {
  step("Lint and format check");
  runOrExit("Lint and format check", "bun", ["run", "check"]);
  step("Type check");
  runOrExit("Type check", "bun", ["run", "check-types"]);
}

step("Verifying Vercel env vars");
ensureEnvVars();

if (!isProduction) {
  step("Skipping schema push (preview shares the production database)");
} else if (skipDb) {
  step("Skipping schema push (--skip-db)");
} else {
  step("Pushing database schema");
  pushSchema();
}

step("Deploying");
const deploymentUrl = deploy();

step(`Health check ${HEALTH_CHECK_PATH}`);
if (!(await waitForHealthy(deploymentUrl))) {
  console.error(
    `Deployment ${deploymentUrl} is up but its health check failed. Inspect it with \`vercel logs --deployment ${deploymentUrl}\`.`
  );
  process.exit(1);
}

console.log(`\nDeployed and healthy: ${deploymentUrl}`);
