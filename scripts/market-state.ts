// Inspect or reset the market side of a Postgres database (plan.md §2.3).
//
// Usage: bun scripts/market-state.ts [--env <file>] [--reset]
//   --env    file to read DATABASE_URL from (default: apps/server/.env)
//   --reset  truncate proposals, matches, demands, offers and market_events
//
// Agent token rows (market_agents) and the public TED data are never touched,
// so the personas keep working after a reset.
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { Pool } from "pg";

const ROOT = path.resolve(import.meta.dirname, "..");
const DEFAULT_ENV_FILE = path.join(ROOT, "apps/server/.env");
const MARKET_TABLES = [
  "proposals",
  "matches",
  "demands",
  "offers",
  "market_events",
] as const;
const COUNTED_TABLES = [...MARKET_TABLES, "market_agents"] as const;

const { values } = parseArgs({
  options: {
    env: { type: "string" },
    reset: { type: "boolean", default: false },
  },
});

const readFromFile = (file: string) => {
  const line = readFileSync(file, "utf-8")
    .split("\n")
    .find((entry) => entry.startsWith("DATABASE_URL="));
  if (!line) {
    throw new Error(`DATABASE_URL is not set in ${file}`);
  }
  return line.slice("DATABASE_URL=".length).trim().replaceAll(/^"|"$/gu, "");
};

const databaseUrl = values.env
  ? readFromFile(path.resolve(values.env))
  : (process.env.DATABASE_URL ?? readFromFile(DEFAULT_ENV_FILE));
const isLocal = /localhost|127\.0\.0\.1/iu.test(databaseUrl);

const pool = new Pool({
  connectionString: databaseUrl,
  ssl: isLocal ? undefined : true,
});

const counts = async () => {
  const rows = await Promise.all(
    COUNTED_TABLES.map(async (table) => {
      const result = await pool.query<{ n: number }>(
        `select count(*)::int as n from ${table}`
      );
      return [table, result.rows[0]?.n ?? 0] as const;
    })
  );
  return Object.fromEntries(rows);
};

console.log(
  JSON.stringify({ state: "before", counts: await counts() }, null, 2)
);

if (values.reset) {
  await pool.query(
    `truncate table ${MARKET_TABLES.join(", ")} restart identity cascade`
  );
  console.log(
    JSON.stringify({ state: "after", counts: await counts() }, null, 2)
  );
}

await pool.end();
