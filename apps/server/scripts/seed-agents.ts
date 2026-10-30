// Generate the agent personas for one listing (plan.md §5.2): a directory per
// persona with its CLAUDE.md (the real company, from public TED records) and
// .mcp.json (market URL + its own bearer token), plus the token rows.
//
// Usage: bun agents:seed <listing_id> [--url <mcp url>] [--out <dir>]
//   --url  market endpoint the agents connect to (default: this server's /api/mcp)
//   --out  where to write the directories (default: <repo>/agents)
// Re-runnable: tokens are rotated and the files rewritten.
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { marketAgents } from "@rocket/db/schema/market";

import { ENV } from "../src/env.server";
import { db } from "../src/services";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const SEED = path.join(ROOT, "data_discovery/data/processed/demo_seed.json");
const DESCRIPTION_CHARS = 1500;
const TOKEN_BYTES = 24;
const TOP_CLASSES = 2;
const CAPACITY = 2;
const MAX_TURNS = 60;
// Pinned: with --setting-sources local the user's default model is not read.
const MODEL = "claude-opus-5-5";
const EFFORT = "high";

interface Award {
  url?: string | null;
  buyer_name?: string | null;
  buyer_country?: string | null;
  supplier_name?: string | null;
  supplier_country?: string | null;
  cpv?: string | null;
  value_eur?: number | null;
  tenders_received?: number | null;
  award_date?: string | null;
  title?: string | null;
}

interface Seed {
  buyers: {
    id: string;
    name: string;
    country: string;
    city: string | null;
    stats: {
      award_count: number;
      median_value_eur: number | null;
      median_tenders_received: number | null;
    };
    awards: Award[];
  }[];
  suppliers: {
    id: string;
    name: string;
    country: string;
    city: string | null;
    size: string | null;
    stats: {
      win_count: number;
      median_value_eur: number | null;
      last_award_date: string | null;
      defence_directive_awards?: number;
    };
    offer_basis: {
      cpv_class: string;
      wins: number;
      median_value_eur: number | null;
      last_award_date: string | null;
      example_title: string | null;
    }[];
    awards: Award[];
  }[];
  listings: {
    id: string;
    external_id: string;
    url: string | null;
    buyer_id: string;
    main_cpv: string;
    cpv_codes: string[];
    title: string;
    title_en: string | null;
    need: string | null;
    description: string | null;
    language: string | null;
    procedure: string | null;
    deadline: string | null;
    estimated_value_eur: number | null;
    n_lots: number | null;
    framework: boolean | null;
    defence_directive: boolean;
  }[];
  personas: { listing_id: string; buyer_id: string; supplier_ids: string[] }[];
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { url: { type: "string" }, out: { type: "string" } },
});
const [listingId] = positionals;
if (!listingId) {
  console.error(
    "Usage: bun agents:seed <listing_id> [--url <mcp url>] [--out <dir>]"
  );
  process.exit(1);
}
const mcpUrl = values.url ?? new URL("/api/mcp", ENV.BETTER_AUTH_URL).href;
const outDir = path.resolve(values.out ?? path.join(ROOT, "agents"));

const seed = JSON.parse(readFileSync(SEED, "utf-8")) as Seed;
const listing = seed.listings.find((entry) => entry.id === listingId);
const persona = seed.personas.find((entry) => entry.listing_id === listingId);
const buyer = seed.buyers.find((entry) => entry.id === persona?.buyer_id);
if (!(listing && persona && buyer)) {
  console.error(
    `No persona set for ${listingId}. Known: ${seed.personas.map((p) => p.listing_id).join(", ")}`
  );
  process.exit(1);
}
const personaSuppliers = persona.supplier_ids.map((id) => {
  const supplier = seed.suppliers.find((entry) => entry.id === id);
  if (!supplier) {
    throw new Error(`Supplier ${id} is not in the seed.`);
  }
  return supplier;
});

// --- Formatting ---------------------------------------------------------------------

const eur = (value: number | null | undefined) =>
  value === null || value === undefined
    ? "n/a"
    : `€${Math.round(value).toLocaleString("en-GB")}`;
const cell = (value: unknown) =>
  String(value ?? "")
    .replaceAll("|", "/")
    .replaceAll("\n", " ");
const link = (url: string | null | undefined) => (url ? `[TED](${url})` : "");
const dirName = (kind: string, id: string) =>
  `${kind}-${id.replaceAll(/[^A-Za-z0-9]+/gu, "-").replaceAll(/^-|-$/gu, "")}`;

const awardTable = (awards: Award[], counterparty: "buyer" | "supplier") => {
  const header =
    counterparty === "buyer"
      ? "| Date | Buyer | What | CPV | Value | Bidders | Notice |\n|---|---|---|---|---|---|---|"
      : "| Date | Supplier | What | CPV | Value | Bidders | Notice |\n|---|---|---|---|---|---|---|";
  const rows = awards.map((award) => {
    const party =
      counterparty === "buyer"
        ? `${cell(award.buyer_name)} (${cell(award.buyer_country)})`
        : `${cell(award.supplier_name)} (${cell(award.supplier_country)})`;
    return `| ${cell(award.award_date)} | ${party} | ${cell(award.title).slice(0, 90)} | ${cell(award.cpv)} | ${eur(award.value_eur)} | ${cell(award.tenders_received ?? "?")} | ${link(award.url)} |`;
  });
  return [header, ...rows].join("\n");
};

const LOOP_RULES = `- You run unattended: no human reads this session or answers questions. Never ask for confirmation or offer options; decide and act with the tools. Posting, proposing, accepting and walking away are exactly what you are here to do.
- You trade only through the \`market\` tools. You cannot see anyone else's limits, and nobody can see yours.
- Each thread is private between one buyer and one supplier. Proposals alternate; you can only concede against your own last proposal (buyers raise, suppliers lower), at most 3 proposals per side. After that only \`accept\` or \`walk_away\` remain.
- If the market answers "outside your limit", you went past your own sealed limit: move back in a sensible step and try again. Never repeat the same refused call.
- \`accept\` signs the other side's standing proposal exactly as it is. That is the contract.
- Messages are short and specific. Argue from public records and cite their TED URLs in \`cites\`. Never invent numbers or awards.`;

const buyerClaudeMd = () => `# You are ${buyer.name}

You are the procurement agent of **${buyer.name}** (${buyer.city ?? ""}, ${buyer.country}), a real public contracting authority. You are buying through an agent marketplace where every supplier is also an agent seeded from its public award history. Everything below is public data from TED (ted.europa.eu).

Your persona id is \`${buyer.id}\`.

## Your notice

- Listing: \`${listing.id}\` · ${link(listing.url)}
- Original title (${listing.language ?? "?"}): ${listing.title}
- In English: ${listing.title_en ?? "(translate it yourself)"}
- Need: ${listing.need ?? ""}
- CPV: ${listing.main_cpv} (${listing.cpv_codes.join(", ")})
- Published estimated value: **${eur(listing.estimated_value_eur)}**
- Deadline: ${listing.deadline ?? "n/a"} · procedure: ${listing.procedure ?? "n/a"} · lots: ${listing.n_lots ?? "n/a"}${listing.defence_directive ? " · defence directive" : ""}

Description, original language (truncated):

> ${cell(listing.description).slice(0, DESCRIPTION_CHARS)}

## Your purchasing record

${buyer.stats.award_count} past awards, median ${eur(buyer.stats.median_value_eur)}, median ${buyer.stats.median_tenders_received ?? "?"} bidders per tender.

${awardTable(buyer.awards, "supplier")}

## How you trade

- Spend public money well. Aim to land at or below the published value. You have a sealed walk-away limit a little above it; if the market says "outside your limit", you offered too much.
- Post your demand for \`${listing.id}\` with the need written in English. The market opens a private thread with each matching supplier, starting from its public ask. You are on turn in each.
- Before your first move in a thread, read the supplier's \`history\`. Cite its own awards ("the Guardia Civil paid you €X against N bidders") and your own record to argue the price down.
- Push hardest on the supplier you most want to win (best record in this CPV, credible lead time). Keep a second thread alive as leverage; you may say in words that you have other offers, but never quote another supplier's numbers.
- Walk away early from a thread you will not take (no relevant record, absurd price, impossible lead time), with a reason.
- Accept when a supplier's standing proposal is a good price for public money. Accepting one thread fills your demand and closes the others.

${LOOP_RULES}

## The loop

1. Call \`whoami\`, then \`my_market\`.
2. If you have no open demand for \`${listing.id}\`, call \`post_demand\`.
3. For every thread where it is your turn: \`propose\`, \`accept\` or \`walk_away\`.
4. Call \`wait\` with the cursor from the previous \`wait\` (start at 0).
5. Repeat from 2 until your demand is filled or every thread is closed. Then stop and write a one-paragraph summary of the outcome.
`;

const supplierClaudeMd = (supplier: (typeof personaSuppliers)[number]) => {
  const topClasses = supplier.offer_basis
    .toSorted((a, b) => b.wins - a.wins)
    .slice(0, TOP_CLASSES)
    .map((entry) => entry.cpv_class);
  const classTable = [
    "| CPV class | Wins | Median award | Last award | Example |",
    "|---|---|---|---|---|",
    ...supplier.offer_basis.map(
      (entry) =>
        `| ${entry.cpv_class} | ${entry.wins} | ${eur(entry.median_value_eur)} | ${cell(entry.last_award_date)} | ${cell(entry.example_title).slice(0, 80)} |`
    ),
  ].join("\n");
  return `# You are ${supplier.name}

You are the sales agent of **${supplier.name}** (${supplier.city ?? ""}, ${supplier.country}${supplier.size ? `, ${supplier.size} company` : ""}), a real European supplier. You sell through an agent marketplace where every public buyer is also an agent. Everything below is your public award history from TED (ted.europa.eu).

Your persona id is \`${supplier.id}\`.

## Your record

${supplier.stats.win_count} public contract wins, median ${eur(supplier.stats.median_value_eur)}, last win ${supplier.stats.last_award_date ?? "n/a"}${supplier.stats.defence_directive_awards ? `, ${supplier.stats.defence_directive_awards} under the defence directive` : ""}.

What you have won, per CPV class (you may only offer in these):

${classTable}

Your most recent awards:

${awardTable(supplier.awards, "buyer")}

## How you trade

- Post one offer in each of your top classes (${topClasses.join(", ")}): an ask near your usual price there, a lead time you can meet, and a one-sentence note on why buyers should pick you. Offers that match a buyer's demand open private threads automatically.
- You have a sealed floor. If the market says "outside your limit", you went too low; stop conceding there.
- Concede in steps, not leaps. Defend your price with your own awards: cite comparable contracts with their TED URLs, the number of bidders you beat, your delivery record.
- Capacity: if you already have ${CAPACITY} agreed threads, walk away from new ones with "at capacity" as the reason.
- Walk away from a thread when the buyer's price is insulting or the lead time is impossible. Accept a buyer's standing proposal when it is a price you can deliver at with a margin.

${LOOP_RULES}

## The loop

1. Call \`whoami\`, then \`my_market\`.
2. If you have no open offer in one of your top classes (${topClasses.join(", ")}), call \`post_offer\` for it.
3. For every thread where it is your turn: \`propose\`, \`accept\` or \`walk_away\`.
4. Call \`wait\` with the cursor from the previous \`wait\` (start at 0).
5. Repeat from 2 until your offers are filled or every thread is closed and nothing new has arrived for three waits. Then stop and write a one-paragraph summary of the outcome.
`;
};

const RUN_COMMAND = `claude -p "Trade now: run the loop in CLAUDE.md until it ends." --model ${MODEL} --effort ${EFFORT} --mcp-config .mcp.json --strict-mcp-config --setting-sources local --allowedTools "mcp__market__*" --max-turns ${MAX_TURNS}`;

// --- Write --------------------------------------------------------------------------

const writePersona = async (
  kind: "buyer" | "supplier",
  id: string,
  name: string,
  claudeMd: string
) => {
  const token = `mkt_${randomBytes(TOKEN_BYTES).toString("base64url")}`;
  const tokenHash = createHash("sha256").update(token).digest("hex");
  await db
    .insert(marketAgents)
    .values({ tokenHash, kind, entityId: id, name })
    .onConflictDoUpdate({
      target: [marketAgents.kind, marketAgents.entityId],
      set: { tokenHash, name, lastSeenAt: null },
    });
  const dir = path.join(
    outDir,
    dirName(kind, kind === "buyer" ? listing.external_id : id)
  );
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "CLAUDE.md"), claudeMd);
  writeFileSync(
    path.join(dir, ".mcp.json"),
    `${JSON.stringify(
      {
        mcpServers: {
          market: {
            type: "http",
            url: mcpUrl,
            headers: { Authorization: `Bearer ${token}` },
          },
        },
      },
      null,
      2
    )}\n`,
    { mode: 0o600 }
  );
  return path.relative(ROOT, dir);
};

// Sequential: each persona is one upsert and two files.
const dirs: string[] = [];
for (const supplier of personaSuppliers) {
  dirs.push(
    // oxlint-disable-next-line no-await-in-loop
    await writePersona(
      "supplier",
      supplier.id,
      supplier.name,
      supplierClaudeMd(supplier)
    )
  );
}
dirs.push(await writePersona("buyer", buyer.id, buyer.name, buyerClaudeMd()));

writeFileSync(
  path.join(outDir, "README.md"),
  `# Agents for ${listing.id}

Generated by \`bun agents:seed ${listing.id}\` against ${mcpUrl}. Each directory is one persona: \`CLAUDE.md\` is the real company, \`.mcp.json\` holds its bearer token (gitignored; re-running the seed rotates every token).

Start the suppliers first, then the buyer (plan.md §5.4). From each directory:

\`\`\`
${RUN_COMMAND}
\`\`\`

For a step-by-step runbook covering both OpenCode and Claude Code, see RUNNING.md in this directory.

${dirs.map((dir) => `- \`${dir}\``).join("\n")}
`
);

console.log(`Wrote ${dirs.length} personas for ${listing.id} → ${mcpUrl}`);
for (const dir of dirs) {
  console.log(`  ${dir}`);
}
console.log(`Run from each directory (suppliers first):\n  ${RUN_COMMAND}`);
process.exit(0);
