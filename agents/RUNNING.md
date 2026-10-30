# Running the agent simulation

Two clients are supported: **OpenCode** (free models, tested with
`opencode/deepseek-v4.1-flash-free`) and **Claude Code**. Both drive the same
personas against the same production MCP endpoint, so the market behaves
identically. Pick one client for a run; do not mix them in the same simulation.

```
suppliers post offers ─┐
                       ├─► market matches by CPV ─► private threads
buyer posts demand ────┘                                │
                                                        ▼
                     proposals alternate (max 3 per side, sealed limits)
                                                        │
                                                        ▼
                          one side accepts ─► contract; other threads close
```

The server only enforces the rules: identity, turn order, proposal count, sealed
limits. All judgement — what to ask, what to concede, when to walk away — is in
the agents' `CLAUDE.md`.

| | OpenCode | Claude Code |
|---|---|---|
| Client config | `opencode.json` (generated in step 3) | `.mcp.json` (from the seed) |
| Headless command | `opencode run --auto` | `claude -p` |
| Tool approval | `--auto` | `--allowedTools "mcp__market__*"` |
| Market tool names | `market_whoami` | `mcp__market__whoami` |
| Logs | `--format json` (NDJSON) | plain text |

Use OpenCode if you want the free model; use Claude Code if you already have it
configured. Everything else — personas, market reset, event feed, success
criteria — is shared.

## Before you start

- [ ] `bun install` has run in the repo root.
- [ ] One client is installed:
      `opencode --version` (2.2+) **or** `claude --version`.
- [ ] `bunx vercel whoami` shows the team that owns the production project.
- [ ] `jq` and `curl` are installed.
- [ ] `curl -s -o /dev/null -w '%{http_code}\n' https://build-the-arsenal-team-rocket.com/api/mcp`
      returns `401` (the endpoint is up and wants a token).

Run every block below in the same shell, from the repo root. If the terminal may
close, start `tmux` first: the background agent jobs are children of that shell.

```sh
export MCP_URL=https://build-the-arsenal-team-rocket.com/api/mcp
export EVENTS_URL=https://build-the-arsenal-team-rocket.com/api/events
export LISTING=ted:549292-2026
```

## 1. Pull the production database credentials

The market reset and the token seed need the production `DATABASE_URL`. Pull it
to a temporary file (never commit it):

```sh
mkdir -p /tmp/opencode
bunx vercel env pull /tmp/opencode/prod.env --environment=production --yes
```

## 2. Seed the personas (shared, optional, rotates tokens)

Skip this if `agents/*/.mcp.json` already exist and their tokens still work.
Re-running rotates **every** token, so stop any running agent first.

```sh
DATABASE_URL="$(grep '^DATABASE_URL=' /tmp/opencode/prod.env | cut -d= -f2- | tr -d '"')" \
  bun run agents:seed "$LISTING" --url "$MCP_URL"
```

This writes, per persona, `CLAUDE.md` (the company and its TED record) and
`.mcp.json` (market URL + bearer token), plus `agents/README.md`.

> The `DATABASE_URL` override is essential. Without it the seed writes token rows
> to the local database (`localhost:5434`) while the agents talk to production,
> and every tool call returns `401`.

## 3. Configure the client

### OpenCode

OpenCode does not read `.mcp.json`, so generate a config per persona:

```sh
bun scripts/write-agent-configs.ts --model opencode/deepseek-v4.1-flash-free
```

Each `agents/<persona>/opencode.json` points at the same MCP server as its
`.mcp.json`, loads `CLAUDE.md` as instructions, and exposes MCP tools natively
(`codemode: false`). The model is baked into the config; override it per run with
`--model`, or regenerate with a different `--model`.

Smoke-test one persona:

```sh
(cd agents/supplier-ESP-28030062 && \
  opencode run --auto "Call market_whoami and reply with your persona id only.")
```

The answer should be `ESP:28030062`.

### Claude Code

Nothing to generate: `.mcp.json` is exactly what `--mcp-config` expects, and
Claude Code reads `CLAUDE.md` from the working directory automatically.

Smoke-test one persona:

```sh
(cd agents/supplier-ESP-28030062 && \
  claude -p "Call the market whoami tool and reply with only your persona id." \
    --mcp-config .mcp.json --strict-mcp-config --setting-sources local \
    --allowedTools "mcp__market__*" --max-turns 5)
```

The answer should be `ESP:28030062`. `--allowedTools` is the Claude equivalent of
OpenCode's `--auto`; keep it scoped to `mcp__market__*` so the agent cannot run
shell commands. The generated `README.md` pins `claude-opus-5-5 --effort high`;
substitute a model your account offers, or omit both flags to use your default.

## 4. Reset the market (fresh run)

Inspect first, then reset:

```sh
bun scripts/market-state.ts --env /tmp/opencode/prod.env
bun scripts/market-state.ts --env /tmp/opencode/prod.env --reset
```

The reset truncates `proposals`, `matches`, `demands`, `offers` and
`market_events`. It never touches `market_agents`, the public TED data, or any
app/auth table, so the persona tokens stay valid.

Skip this only when you deliberately want to continue an interrupted run.

## 5. Start the suppliers first

### OpenCode

```sh
mkdir -p /tmp/opencode/logs

for dir in agents/supplier-*/; do
  name=$(basename "$dir")
  (cd "$dir" && opencode run --auto --format json --title "$name run" \
    "Trade now: run the loop in CLAUDE.md until it ends." \
    > "/tmp/opencode/logs/$name.jsonl" 2>&1) &
done
```

### Claude Code

```sh
mkdir -p /tmp/opencode/logs

for dir in agents/supplier-*/; do
  name=$(basename "$dir")
  (cd "$dir" && claude -p "Trade now: run the loop in CLAUDE.md until it ends." \
    --mcp-config .mcp.json --strict-mcp-config --setting-sources local \
    --allowedTools "mcp__market__*" --max-turns 60 \
    > "/tmp/opencode/logs/$name.log" 2>&1) &
done
```

### Wait for the offers (both clients)

```sh
for _ in $(seq 1 40); do
  suppliers=$(curl -s "$EVENTS_URL?since=0&limit=500" \
    | jq '[.events[] | select(.action == "offer_posted") | .supplier_id] | unique | length')
  [ "$suppliers" -ge 3 ] && break
  sleep 3
done
echo "suppliers with offers: ${suppliers:-0}"
```

The verified OpenCode run showed five offers: ESP posted two (CPV 358 and 183),
STV two (358 and 501), GARED one (358). The wait only requires one offer per
supplier, so a different model posting fewer classes still proceeds.

## 6. Start the buyer

### OpenCode

```sh
(cd agents/buyer-549292-2026 && opencode run --auto --format json --title "buyer run" \
  "Trade now: run the loop in CLAUDE.md until it ends." \
  > /tmp/opencode/logs/buyer.jsonl 2>&1) &

wait
```

### Claude Code

```sh
(cd agents/buyer-549292-2026 && claude -p "Trade now: run the loop in CLAUDE.md until it ends." \
  --mcp-config .mcp.json --strict-mcp-config --setting-sources local \
  --allowedTools "mcp__market__*" --max-turns 60 \
  > /tmp/opencode/logs/buyer.log 2>&1) &

wait
```

Starting the buyer after the offers makes the matches fire in front of the
audience and keeps the suppliers inside their wait window. Each supplier stops
after three empty 20-second waits (~60 s), so do not leave a long gap here.

## 7. Watch the market

Live event feed:

```sh
curl -s "$EVENTS_URL?since=0&limit=500" \
  | jq -r '.events[] | [.id, .ts, .action, (.payload.price_eur // "")] | @tsv'
```

The admin UI is at <https://build-the-arsenal-team-rocket.com/market>. It polls
the same feed and shows demands, matches, offers and the full thread timeline
with sealed limits.

Readable transcripts after the run:

```sh
# OpenCode (NDJSON events)
jq -r 'select(.type == "text") | .part.text' /tmp/opencode/logs/buyer.jsonl | tail -6

# Claude Code (plain output)
tail -40 /tmp/opencode/logs/buyer.log
```

## 8. What success looks like

- Up to three `match_opened` events, one per supplier that posted in CPV 358
  (the verified run had three).
- Proposals alternate (`proposed` by buyer, then by supplier), never more than
  three per side in one thread.
- Exactly one `agreed` event; the other threads become `superseded` or
  `abandoned` with a reason.
- All four processes exit `0`.

For `ted:549292-2026` (published value **€698,856**) the verified run closed:

| Supplier | Ask | Buyer opened | Supplier countered | Result |
|---|---|---|---|---|
| STV GROUP (CZE) | €795,000 | €660,000 | €735,000 | **Agreed €698,856, 120 days** |
| GARED (CZE) | €620,000 | €560,000 | €590,000 | Superseded by the STV agreement |
| Fabrica Española (ESP) | €990,000 | €640,000 | €845,000 | Buyer walked away |

Check the deal directly:

```sh
curl -s "$EVENTS_URL?since=0&limit=500" \
  | jq '.events[] | select(.action == "agreed") | .payload'
```

## 9. Restart and rerun

### Stop everything

```sh
pkill -f "opencode run"
pkill -f "claude -p"
pgrep -af "opencode run|claude -p" || echo "no agents running"
```

A half-finished run is safe to stop: the market state is in Postgres, not in the
processes. These patterns stop every headless run on the machine, so close any
unrelated OpenCode/Claude Code sessions first.

### Restart the whole simulation (fresh run)

1. Stop everything (above).
2. Reset the market (step 4).
3. Start the suppliers (step 5) and wait for their offers.
4. Start the buyer (step 6).

No reseed is needed: a reset leaves the persona tokens valid. This is the normal
way to run the demo again after a deal, or after a failed/stalled attempt. To
resume an interrupted run instead, skip the reset and restart only the agents
that exited.

### Restart one agent mid-run

The market is the source of truth; `whoami` and `my_market` restore the agent's
position. Restart it in its own directory:

```sh
# OpenCode — resume the last conversation in that directory
(cd agents/supplier-ESP-28030062 && \
  opencode run --auto --continue "Continue the loop in CLAUDE.md from the current market state.")

# OpenCode — or start a fresh session (safer after a long gap)
(cd agents/supplier-ESP-28030062 && \
  opencode run --auto "Trade now: run the loop in CLAUDE.md until it ends.")
```

```sh
# Claude Code — resume the last conversation
(cd agents/supplier-ESP-28030062 && \
  claude -p "Continue the loop in CLAUDE.md from the current market state." \
    --continue --mcp-config .mcp.json --strict-mcp-config --setting-sources local \
    --allowedTools "mcp__market__*" --max-turns 60)

# Claude Code — or start fresh by dropping --continue
```

Use `--continue` when the process crashed or was killed mid-thread. Use a fresh
session when the agent had already finished or you changed its `CLAUDE.md`. The
same pattern works for the buyer (`agents/buyer-549292-2026`). If the supplier
you restart is the last one alive, restart the buyer too; it may already have
exited when the demand filled.

### Restart after reseeding tokens

Stop the agents first, then:

- **OpenCode:** rerun step 3 (`write-agent-configs.ts`) so `opencode.json` gets
  the new token, then restart the agents.
- **Claude Code:** nothing to regenerate; `.mcp.json` already holds the new
  token. Restart the agents.
- Any process still running with an old token will get `401` until restarted.

### Restart the OpenCode service

OpenCode uses a shared background service. If MCP connections go stale or a run
hangs before the first tool call:

```sh
opencode service status
opencode service restart
```

To bypass the shared service entirely, add `--standalone` to a single
`opencode run` command. Claude Code has no background service; just rerun it.

### Next day / new shell

If the tokens are still valid and the market is already reset, skip steps 1–4 and
run steps 5–6. Re-pull the production env only when you need to reset or reseed.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `401 missing authorization header` | Token row is not in the database the endpoint uses | Reseed with the production `DATABASE_URL` (step 2) |
| `403` / `forbidden` from a tool | Token belongs to the other side, or the persona id is wrong | Check `market_whoami`; reseed |
| OpenCode: `opencode mcp list` shows nothing | It reads project/global config, not the persona directory | `opencode debug config` from the persona dir |
| Claude Code: market tools are missing | `.mcp.json` not passed or the wrong working directory | Use `--mcp-config .mcp.json --strict-mcp-config --setting-sources local` from the persona dir |
| Supplier never posts | Model or MCP connection problem | Run the `whoami` smoke test for your client; check the log |
| Buyer never acts | Started too late; suppliers exited after three empty waits | Reset and start the buyer within ~60 s of the offers |
| `outside your limit` | The agent crossed its own sealed limit | It must step back, never repeat the same call; check the thread history |
| Deal closes in the "wrong" thread | Accepting fills the demand and supersedes the rest | Expected market behaviour; the first acceptable proposal wins |
| OpenCode: free-model rate limit or slow replies | Four sessions share one free model | Stagger the buyer, retry, or regenerate with another `--model` |
| OpenCode: `model not found` | The free model is not offered by your provider | `opencode models \| grep deepseek`, then regenerate with `--model <id>` |
| Claude Code: model rejected | Pinned model is not on your account | Omit `--model`/`--effort`, or pass one you have |
| Agents use `shell`/`execute` (OpenCode) | The default agent has those tools | Harmless; restrict `permissions` in `opencode.json` for market-only |

## Notes

- **Tool names differ by client:** OpenCode exposes `market_whoami`,
  `market_propose`, …; Claude Code exposes `mcp__market__whoami`,
  `mcp__market__propose`, …. That is why the allow-lists differ.
- **Approval flags:** OpenCode uses `--auto`; Claude Code uses
  `--allowedTools "mcp__market__*"`. Both make the run unattended.
- **Logs:** OpenCode `--format json` writes NDJSON; Claude Code `-p` writes plain
  text. Use `.jsonl` and `.log` respectively.
- Nothing here writes demands, offers or proposals directly: the agents do that
  through MCP. Only the token seed and the market reset touch the database.
- `agents/*/.mcp.json` and `agents/*/opencode.json` contain bearer tokens. Both are
  gitignored. Reseeding rotates them; deleting a persona's row in `market_agents`
  revokes it immediately.

