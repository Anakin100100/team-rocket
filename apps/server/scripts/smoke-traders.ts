// Smoke test for signed-in users as traders (plan.md §5.1) and the market's
// edge cases: claiming a company, user-set limits, buying and selling as one
// company, no self-trade, withdraw, deadlines, a listing bought once, and the
// persona thread-floor and re-matching rules. Code actors, no model. Local
// databases only: it wipes the market-side tables and its own test users.
//
// Usage (from apps/server): bun run market:traders
import { user } from "@rocket/db/schema/auth";
import {
  buyers,
  demands,
  listings,
  marketAgents,
  marketEvents,
  matches,
  offers,
  proposals,
  suppliers,
} from "@rocket/db/schema/market";
import { runTool, traderActor } from "@rocket/market";
import type { Actor, ToolOutcome } from "@rocket/market";
import { eq, inArray, like, or } from "drizzle-orm";

import { ENV } from "../src/env.server";
import { db, market } from "../src/services";

const DAY_MS = 86_400_000;
const DEADLINE_DAYS = 30;
const LEAD_TIME = 60;
const CPV = "35815100";
const CPV_CLASS = "358";

const USER_A = "smoke-user-a";
const USER_B = "smoke-user-b";
const TEST_USERS = [USER_A, USER_B];
// Quantum Systems GmbH: a public supplier no agent persona plays.
const CLAIMED = "DEU:298856333";
const AGENT_PLAYED = "CZE:26181134";
const NO_VALUE_LISTING = "smoke:no-value";

const LISTING_A = "ted:549292-2026";
const LISTING_B = "ted:741774-2026";
const buyerA: Actor = {
  kind: "buyer",
  entityId: "ted-buyer:00212008",
  name: "buyer A",
};
const buyerB: Actor = {
  kind: "buyer",
  entityId: "ted-buyer:13002345000013",
  name: "buyer B",
};
const supplierA: Actor = {
  kind: "supplier",
  entityId: "ESP:28030062",
  name: "supplier A",
};

let failures = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  if (ok) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${label}`, detail === undefined ? "" : detail);
  }
};

const call = (actor: Actor, tool: string, input: unknown = {}) =>
  runTool(market, actor, tool, input);
const result = <T>(outcome: ToolOutcome): T => {
  if (!outcome.ok) {
    throw new Error(`${outcome.error.code}: ${outcome.error.message}`);
  }
  return outcome.result as T;
};
const succeeded = (outcome: ToolOutcome) => outcome.ok;
const refused = (outcome: ToolOutcome, fragment: string) =>
  !outcome.ok && outcome.error.message.toLowerCase().includes(fragment);
// Like the MCP door: a user's actor is resolved again on every request.
const as = (userId: string) => traderActor(db, userId, userId);
const inDays = (days: number) =>
  new Date(Date.now() + days * DAY_MS).toISOString().slice(0, 10);

interface Thread {
  match_id: string;
  you_are: string | null;
}
interface Opened {
  match_id: string;
  listing_id: string;
  supplier_id: string;
}

const wipe = async () => {
  await db.delete(marketEvents);
  await db.delete(proposals);
  await db.delete(matches);
  await db.delete(offers);
  await db.delete(demands);
  await db
    .delete(listings)
    .where(
      or(like(listings.id, "listing:%"), eq(listings.id, NO_VALUE_LISTING))
    );
  await db.delete(user).where(inArray(user.id, TEST_USERS));
  const ownCompanies = TEST_USERS.map((id) => `user:${id}`);
  await db.delete(buyers).where(inArray(buyers.id, [CLAIMED, ...ownCompanies]));
  await db.delete(suppliers).where(inArray(suppliers.id, ownCompanies));
};

if (!/localhost|127\.0\.0\.1/u.test(ENV.DATABASE_URL)) {
  console.error("Refusing to wipe a non-local database.");
  process.exit(1);
}
await wipe();
await db
  .insert(user)
  .values(
    TEST_USERS.map((id) => ({ id, name: id, email: `${id}@example.test` }))
  );
console.log("market tables and test users wiped\n");

// --- Identity ---------------------------------------------------------------------
console.log("identity");
check(
  "a persona cannot set limits",
  refused(
    await call(supplierA, "set_limits", { floor_pct: 90 }),
    "signed-in users"
  )
);
const fresh = result<{ company: unknown; next_step?: string }>(
  await call(await as(USER_A), "whoami")
);
check(
  "a new user has no company and is told to set one",
  fresh.company === null && Boolean(fresh.next_step)
);
check(
  "a user without a company cannot post",
  refused(
    await call(await as(USER_A), "post_offer", {
      cpv_class: CPV_CLASS,
      ask_eur: 1000,
      lead_time_days: LEAD_TIME,
      note: "x",
    }),
    "set_company"
  )
);
const [agentRow] = await db
  .select({ id: marketAgents.entityId })
  .from(marketAgents)
  .where(eq(marketAgents.entityId, AGENT_PLAYED));
if (agentRow) {
  check(
    "a company an agent plays cannot be claimed",
    refused(
      await call(await as(USER_A), "set_company", {
        country: "CZE",
        registry_number: "CZ26181134",
      }),
      "market agent"
    )
  );
} else {
  console.log("  skip agent claim check: run agents:seed to create personas");
}
const claimed = result<{ company_id: string; public_record: boolean }>(
  await call(await as(USER_A), "set_company", {
    country: "deu",
    registry_number: "DE 298 856 333",
  })
);
check(
  "a VAT number claims its public record",
  claimed.company_id === CLAIMED && claimed.public_record,
  claimed
);
check(
  "a claimed company cannot be claimed twice",
  refused(
    await call(await as(USER_B), "set_company", {
      country: "DEU",
      registry_number: "298856333",
    }),
    "already claimed"
  )
);
check(
  "an unknown number without a name is refused",
  refused(
    await call(await as(USER_B), "set_company", {
      country: "POL",
      registry_number: "PL 999 999 9999",
    }),
    "no public record"
  )
);
const own = result<{ company_id: string; public_record: boolean }>(
  await call(await as(USER_B), "set_company", {
    country: "POL",
    name: "Smoke Defence Sp. z o.o.",
  })
);
check(
  "a name gives the user a company of its own",
  own.company_id === `user:${USER_B}` && !own.public_record,
  own
);
const userA = await as(USER_A);
const userB = await as(USER_B);
const meA = result<{
  kind: string;
  id: string;
  your_limits: { walk_away_pct: number; floor_pct: number };
}>(await call(userA, "whoami"));
check(
  "whoami shows the company and the default limits",
  meA.kind === "trader" &&
    meA.id === CLAIMED &&
    meA.your_limits.walk_away_pct === 110 &&
    meA.your_limits.floor_pct === 80,
  meA
);
const historyA = result<{ kind: string }>(
  await call(userA, "history", { entity_id: CLAIMED })
);
check(
  "a trader's history covers both sides",
  historyA.kind === "buyer and supplier"
);

// --- Limits -----------------------------------------------------------------------
console.log("\nlimits");
check(
  "set_limits needs at least one limit",
  refused(await call(userA, "set_limits", {}), "walk_away_pct")
);
const limitsA = result<{ your_limits: { floor_pct: number } }>(
  await call(userA, "set_limits", { floor_pct: 90 })
);
check("A's floor is now 90%", limitsA.your_limits.floor_pct === 90);
result(await call(userB, "set_limits", { walk_away_pct: 120 }));

// --- Buying and selling as one company -------------------------------------------
console.log("\nbuy and sell");
const offerA = result<{ offer_id: string }>(
  await call(userA, "post_offer", {
    cpv_class: CPV_CLASS,
    ask_eur: 500_000,
    lead_time_days: LEAD_TIME,
    note: "Any class: users are not limited to what they won.",
  })
);
check("a user offers in a class it never won", Boolean(offerA.offer_id));
check(
  "an own demand needs every field",
  refused(
    await call(userB, "post_demand", { title: "Plate carriers", cpv: CPV }),
    "estimated_value_eur, deadline"
  )
);
const demandB = result<{ listing_id: string; matches_opened: Opened[] }>(
  await call(userB, "post_demand", {
    title: "Plate carriers",
    cpv: CPV,
    estimated_value_eur: 600_000,
    deadline: inDays(DEADLINE_DAYS),
  })
);
check(
  "B's own demand matches A's offer",
  demandB.matches_opened.length === 1 &&
    demandB.matches_opened[0]?.supplier_id === CLAIMED,
  demandB.matches_opened
);
const threadBA = demandB.matches_opened[0]?.match_id ?? "";
const demandA = result<{ demand_id: string; matches_opened: Opened[] }>(
  await call(userA, "post_demand", {
    title: "Spare plates",
    cpv: CPV,
    estimated_value_eur: 450_000,
    deadline: inDays(DEADLINE_DAYS),
  })
);
check(
  "A's demand never matches A's own offer",
  demandA.matches_opened.length === 0,
  demandA.matches_opened
);
const offerB = result<{ offer_id: string; matches_opened: Opened[] }>(
  await call(userB, "post_offer", {
    cpv_class: CPV_CLASS,
    ask_eur: 400_000,
    lead_time_days: LEAD_TIME,
    note: "Polish body armour.",
  })
);
check(
  "B's offer matches A's demand and not B's own",
  offerB.matches_opened.length === 1 &&
    offerB.matches_opened[0]?.listing_id !== demandB.listing_id,
  offerB.matches_opened
);
const threadAB = offerB.matches_opened[0]?.match_id ?? "";
const marketA = result<{ threads: Thread[]; your_turn_in: string[] }>(
  await call(userA, "my_market")
);
const sides = Object.fromEntries(
  marketA.threads.map((thread) => [thread.match_id, thread.you_are])
);
check(
  "A is the supplier in one thread and the buyer in the other",
  sides[threadBA] === "supplier" && sides[threadAB] === "buyer",
  sides
);
check(
  "A's turn is only where A is the buyer",
  marketA.your_turn_in.length === 1 && marketA.your_turn_in[0] === threadAB,
  marketA.your_turn_in
);
const newsB = result<{ events: { action: string; match_id: string }[] }>(
  await call(userB, "wait", { since: 0, timeout_s: 1 })
);
const opened = new Set(
  newsB.events
    .filter((event) => event.action === "match_opened")
    .map((event) => event.match_id)
);
check(
  "B hears of both its threads, on either side",
  opened.has(threadBA) && opened.has(threadAB),
  newsB.events.map((event) => event.action)
);

// --- User limits, enforced -------------------------------------------------------
console.log("\nlimits enforced");
check(
  "B cannot pay over 120% of its estimate",
  refused(
    await call(userB, "propose", {
      match_id: threadBA,
      price_eur: 800_000,
      lead_time_days: LEAD_TIME,
      message: "x",
    }),
    "outside your limit"
  )
);
result(
  await call(userB, "propose", {
    match_id: threadBA,
    price_eur: 460_000,
    lead_time_days: LEAD_TIME,
    message: "460k.",
  })
);
check(
  "A cannot sell under 90% of its ask",
  refused(
    await call(userA, "propose", {
      match_id: threadBA,
      price_eur: 440_000,
      lead_time_days: LEAD_TIME,
      message: "x",
    }),
    "outside your limit"
  )
);
result(
  await call(userA, "propose", {
    match_id: threadBA,
    price_eur: 480_000,
    lead_time_days: LEAD_TIME,
    message: "480k.",
  })
);
const deal = result<{ state: string; price_eur: number }>(
  await call(userB, "accept", { match_id: threadBA })
);
check(
  "B and A agree at 480k",
  deal.state === "agreed" && deal.price_eur === 480_000,
  deal
);
check(
  "a listing is bought once",
  refused(
    await call(userB, "post_demand", { listing_id: demandB.listing_id }),
    "already bought"
  )
);

// --- Withdraw and switching company ----------------------------------------------
console.log("\nwithdraw");
check(
  "nobody withdraws someone else's demand",
  refused(
    await call(userB, "withdraw", {
      posting_id: demandA.demand_id,
      reason: "x",
    }),
    "not yours"
  )
);
const withdrawn = result<{ threads_closed: string[] }>(
  await call(userA, "withdraw", {
    posting_id: demandA.demand_id,
    reason: "Budget moved to next year.",
  })
);
check(
  "withdrawing a demand ends its threads",
  withdrawn.threads_closed.length === 1 &&
    withdrawn.threads_closed[0] === threadAB
);
check(
  "a withdrawn demand cannot be withdrawn again",
  refused(
    await call(userA, "withdraw", {
      posting_id: demandA.demand_id,
      reason: "x",
    }),
    "withdrawn"
  )
);
const toldB = result<{
  events: { action: string; payload: { reason?: string } }[];
}>(await call(userB, "wait", { since: 0, timeout_s: 1 }));
check(
  "B reads why its thread ended",
  toldB.events.some(
    (event) =>
      event.action === "walked_away" &&
      String(event.payload.reason).includes("Budget moved")
  )
);
check(
  "no switching company with an open offer",
  refused(
    await call(userB, "set_company", {
      country: "DEU",
      registry_number: "481250",
    }),
    "withdraw your open"
  )
);
check(
  "renaming one's own company is fine",
  succeeded(
    await call(userB, "set_company", {
      country: "POL",
      name: "Smoke Defence S.A.",
    })
  )
);

// --- Deadlines --------------------------------------------------------------------
console.log("\ndeadline");
const lateDemand = result<{ listing_id: string }>(
  await call(userB, "post_demand", {
    title: "Helmets",
    cpv: CPV,
    estimated_value_eur: 300_000,
    deadline: inDays(DEADLINE_DAYS),
  })
);
const lateOffer = result<{ matches_opened: Opened[] }>(
  await call(userA, "post_offer", {
    cpv_class: CPV_CLASS,
    ask_eur: 250_000,
    lead_time_days: LEAD_TIME,
    note: "Helmets too.",
  })
);
const lateThread = lateOffer.matches_opened[0]?.match_id ?? "";
check("A's new offer meets B's new demand", Boolean(lateThread));
await db
  .update(listings)
  .set({ deadline: inDays(-1) })
  .where(eq(listings.id, lateDemand.listing_id));
check(
  "no proposals after the listing's deadline",
  refused(
    await call(userB, "propose", {
      match_id: lateThread,
      price_eur: 200_000,
      lead_time_days: LEAD_TIME,
      message: "x",
    }),
    "deadline has passed"
  )
);
check(
  "walking away still works after the deadline",
  succeeded(
    await call(userB, "walk_away", {
      match_id: lateThread,
      reason: "Too late.",
    })
  )
);

// --- Persona edge cases ------------------------------------------------------------
console.log("\npersonas");
await db.delete(marketEvents);
await db.delete(proposals);
await db.delete(matches);
await db.delete(offers);
await db.delete(demands);
result(
  await call(supplierA, "post_offer", {
    cpv_class: CPV_CLASS,
    ask_eur: 700_000,
    lead_time_days: LEAD_TIME,
    note: "Opening ask well under 60% of the big demand.",
  })
);
const bigDemand = result<{ matches_opened: Opened[] }>(
  await call(buyerB, "post_demand", { listing_id: LISTING_B })
);
const bigThread = bigDemand.matches_opened[0]?.match_id ?? "";
result(
  await call(buyerB, "propose", {
    match_id: bigThread,
    price_eur: 600_000,
    lead_time_days: LEAD_TIME,
    message: "600k.",
  })
);
check(
  "a supplier can stand on an ask below 60% of the demand's value",
  succeeded(
    await call(supplierA, "propose", {
      match_id: bigThread,
      price_eur: 700_000,
      lead_time_days: LEAD_TIME,
      message: "Our ask stands.",
    })
  )
);
const smallDemand = result<{ matches_opened: Opened[] }>(
  await call(buyerA, "post_demand", { listing_id: LISTING_A })
);
const smallThread = smallDemand.matches_opened[0]?.match_id ?? "";
const sold = result<{ superseded: string[] }>(
  await call(buyerA, "accept", { match_id: smallThread })
);
check(
  "selling to A supersedes the thread with B",
  sold.superseded.includes(bigThread),
  sold.superseded
);
const again = result<{ matches_opened: Opened[] }>(
  await call(supplierA, "post_offer", {
    cpv_class: CPV_CLASS,
    ask_eur: 690_000,
    lead_time_days: LEAD_TIME,
    note: "New lot.",
  })
);
check(
  "a new offer meets B's demand again after the supersede",
  again.matches_opened.some((thread) => thread.listing_id === LISTING_B),
  again.matches_opened
);
await db.insert(listings).values({
  id: NO_VALUE_LISTING,
  externalId: NO_VALUE_LISTING,
  buyerId: buyerA.entityId ?? "",
  mainCpv: CPV,
  cpvCodes: [CPV],
  title: "No published value",
  deadline: inDays(DEADLINE_DAYS),
  fetchedAt: new Date(),
});
check(
  "a listing without a value is refused, not silently unmatched",
  refused(
    await call(buyerA, "post_demand", { listing_id: NO_VALUE_LISTING }),
    "no published value"
  )
);

await wipe();
console.log(`\n${failures === 0 ? "ALL OK" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
