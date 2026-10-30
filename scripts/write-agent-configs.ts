// Write an opencode.json for every persona directory in agents/, reusing the
// market URL and bearer token from the .mcp.json written by `bun agents:seed`.
// The result is gitignored because it contains the persona's bearer token.
//
// Usage: bun scripts/write-agent-configs.ts [--model <provider/model>] [--agents <dir>]
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const ROOT = path.resolve(import.meta.dirname, "..");
const DEFAULT_AGENTS_DIR = path.join(ROOT, "agents");
const DEFAULT_MODEL = "opencode/deepseek-v4.1-flash-free";

interface McpFile {
  mcpServers: {
    market: {
      url: string;
      headers: Record<string, string>;
    };
  };
}

const { values } = parseArgs({
  options: {
    model: { type: "string", default: DEFAULT_MODEL },
    agents: { type: "string" },
  },
});

const agentsDir = path.resolve(values.agents ?? DEFAULT_AGENTS_DIR);

const personaDirs = readdirSync(agentsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => path.join(agentsDir, entry.name))
  .filter((dir) => {
    try {
      readFileSync(path.join(dir, ".mcp.json"));
      return true;
    } catch {
      return false;
    }
  });

for (const dir of personaDirs) {
  const mcp = JSON.parse(
    readFileSync(path.join(dir, ".mcp.json"), "utf-8")
  ) as McpFile;
  const { url, headers } = mcp.mcpServers.market;
  const config = {
    $schema: "https://opencode.ai/config.json",
    model: values.model,
    instructions: ["CLAUDE.md"],
    mcp: {
      servers: {
        market: {
          type: "remote",
          url,
          oauth: false,
          headers,
          // Native tool calls instead of OpenCode's Code Mode wrapper.
          codemode: false,
        },
      },
    },
    permissions: [{ action: "*", resource: "*", effect: "allow" }],
  };
  writeFileSync(
    path.join(dir, "opencode.json"),
    `${JSON.stringify(config, null, 2)}\n`
  );
  console.log(`${path.relative(ROOT, dir)}  →  ${values.model}`);
}

console.log(`Wrote ${personaDirs.length} configs under ${agentsDir}`);
