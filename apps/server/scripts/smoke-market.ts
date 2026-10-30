// Smoke test for the market (plan.md §4): drives one full negotiation through
// the tools with code actors, no model, and checks the guards and visibility
// rules along the way. Local databases only: it wipes the market-side tables
// first so it can run again.
//
// Usage (from apps/server): bun run market:smoke
import {
  demands,
  marketEvents,
  matches,
  offers,
  proposals,
} from "@rocket/db/schema/market";
import { runTool } from "@rocket/market";
import type { Actor, ToolOutcome } from "@rocket/market";

import { ENV } from "../src/env.server";
import { db, market } from "../src/services";

const LISTING = "ted:549292-2026";
const BUYER_ID = "ted-buyer:00212008";
const SUPPLIER_A = "ESP:28030062";
const SUPPLIER_B = "CZE:26181134";
const CPV_CLASS = "358";
const LEAD_TIME = 70;

const buyer: Actor = { kind: "buyer", entityId: BUYER_ID, name: "buyer" };
const supplierA: Actor = {
  kind: "supplier",
  entityId: SUPPLIER_A,
  name: "Fabrica",
};
const supplierB: Actor = {
  kind: "supplier",
  entityId: SUPPLIER_B,
  name: "STV",
};
const observer: Actor = { kind: "observer", entityId: null, name: "smoke" };

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
const refused = (outcome: ToolOutcome, fragment: string) =>
  !outcome.ok && outcome.error.message.toLowerCase().includes(fragment);

if (!/localhost|127\.0\.0\.1/u.test(ENV.DATABASE_URL)) {
  console.error("Refusing to wipe a non-local database.");
  process.exit(1);
}
await db.delete(marketEvents);
await db.delete(proposals);
await db.delete(matches);
await db.delete(offers);
await db.delete(demands);
console.log("market tables wiped\n");

// --- whoami -------------------------------------------------------------------------
console.log("whoami");
const meA = result<{ classes_you_can_offer_in: { cpv_class: string }[] }>(
  await call(supplierA, "whoami")
);
check(
  "supplier sees its classes",
  meA.classes_you_can_offer_in.some((c) => c.cpv_class === CPV_CLASS)
);
check(
  "supplier whoami carries no floor",
  !JSON.stringify(meA).includes("floor")
);
const meBuyer = result<{ your_listings: { listing_id: string }[] }>(
  await call(buyer, "whoami")
);
check(
  "buyer sees its listing",
  meBuyer.your_listings.some((l) => l.listing_id === LISTING)
);
check(
  "buyer whoami carries no walk-away",
  !JSON.stringify(meBuyer).includes("walk_away")
);

// --- offers first, then the demand ---------------------------------------------------
console.log("\npostings");
check(
  "buyer cannot post an offer",
  refused(
    await call(buyer, "post_offer", {
      cpv_class: CPV_CLASS,
      ask_eur: 1,
      lead_time_days: 1,
      note: "x",
    }),
    "only a supplier"
  )
);
check(
  "ask below floor is refused",
  refused(
    await call(supplierA, "post_offer", {
      cpv_class: CPV_CLASS,
      ask_eur: 1000,
      lead_time_days: LEAD_TIME,
      note: "too cheap",
    }),
    "outside your limit"
  )
);
const offerA = result<{ offer_id: string; matches_opened: unknown[] }>(
  await call(supplierA, "post_offer", {
    cpv_class: CPV_CLASS,
    ask_eur: 860_000,
    lead_time_days: LEAD_TIME,
    note: "Ballistic vests for Guardia Civil, 15 wins in class 358.",
  })
);
check("offer A posted, no demand yet", offerA.matches_opened.length === 0);
check(
  "second open offer in the same class is refused",
  refused(
    await call(supplierA, "post_offer", {
      cpv_class: CPV_CLASS,
      ask_eur: 900_000,
      lead_time_days: LEAD_TIME,
      note: "dup",
    }),
    "already have an open offer"
  )
);
result(
  await call(supplierB, "post_offer", {
    cpv_class: CPV_CLASS,
    ask_eur: 790_000,
    lead_time_days: 90,
    note: "STV GROUP, Czech body armour.",
  })
);
const demand = result<{
  demand_id: string;
  matches_opened: { supplier_id: string; match_id: string }[];
}>(
  await call(buyer, "post_demand", {
    listing_id: LISTING,
    need: "350 plate carriers with hard plates, delivery to Bratislava.",
  })
);
check(
  "demand matched both offers",
  demand.matches_opened.length === 2,
  demand.matches_opened
);
check(
  "duplicate demand refused",
  refused(
    await call(buyer, "post_demand", { listing_id: LISTING }),
    "already have an open demand"
  )
);
const threadA = demand.matches_opened.find(
  (m) => m.supplier_id === SUPPLIER_A
)?.match_id;
const threadB = demand.matches_opened.find(
  (m) => m.supplier_id === SUPPLIER_B
)?.match_id;
if (!(threadA && threadB)) {
  throw new Error("expected threads with both suppliers");
}

// --- visibility --------------------------------------------------------------------
console.log("\nvisibility");
const marketA = result<{ threads: { match_id: string }[] }>(
  await call(supplierA, "my_market")
);
check(
  "supplier A sees only its own thread",
  marketA.threads.length === 1 && marketA.threads[0]?.match_id === threadA
);
check(
  "supplier A sees no sealed values",
  !JSON.stringify(marketA).includes("sealed")
);
check(
  "supplier B cannot act in A's thread",
  refused(
    await call(supplierB, "walk_away", { match_id: threadA, reason: "x" }),
    "not a party"
  )
);
const marketBuyer = result<{ threads: { proposals: unknown[] }[] }>(
  await call(buyer, "my_market")
);
check(
  "buyer sees both threads with the opening ask",
  marketBuyer.threads.length === 2 &&
    marketBuyer.threads.every((t) => t.proposals.length === 1)
);
const obs = result<{ threads: { sealed?: unknown }[] }>(
  await call(observer, "my_market")
);
check(
  "observer sees sealed limits",
  obs.threads.length === 2 && obs.threads.every((t) => t.sealed !== undefined)
);

// --- negotiation guards ------------------------------------------------------------------
console.log("\nnegotiation");
check(
  "supplier cannot move out of turn",
  refused(
    await call(supplierA, "propose", {
      match_id: threadA,
      price_eur: 850_000,
      lead_time_days: LEAD_TIME,
      message: "x",
    }),
    "not your turn"
  )
);
check(
  "buyer cannot exceed its walk-away",
  refused(
    await call(buyer, "propose", {
      match_id: threadA,
      price_eur: 2_000_000,
      lead_time_days: LEAD_TIME,
      message: "x",
    }),
    "outside your limit"
  )
);
result(
  await call(buyer, "propose", {
    match_id: threadA,
    price_eur: 650_000,
    lead_time_days: LEAD_TIME,
    message: "Guardia Civil paid you 729k against 5 bidders last month.",
    cites: ["https://ted.europa.eu/en/notice/-/detail/668870-2026"],
  })
);
check(
  "supplier cannot go below thread floor",
  refused(
    await call(supplierA, "propose", {
      match_id: threadA,
      price_eur: 100_000,
      lead_time_days: LEAD_TIME,
      message: "x",
    }),
    "outside your limit"
  )
);
result(
  await call(supplierA, "propose", {
    match_id: threadA,
    price_eur: 780_000,
    lead_time_days: 56,
    message: "Those were repeat lots. 780k and 8 weeks.",
  })
);
check(
  "buyer cannot concede downwards",
  refused(
    await call(buyer, "propose", {
      match_id: threadA,
      price_eur: 600_000,
      lead_time_days: 56,
      message: "x",
    }),
    "only concede"
  )
);
result(
  await call(buyer, "propose", {
    match_id: threadA,
    price_eur: 740_000,
    lead_time_days: 56,
    message: "Meet me at 740k.",
  })
);
result(
  await call(supplierA, "propose", {
    match_id: threadA,
    price_eur: 760_000,
    lead_time_days: 56,
    message: "Last step from our side: 760k.",
  })
);
result(
  await call(buyer, "propose", {
    match_id: threadA,
    price_eur: 750_000,
    lead_time_days: 56,
    message: "750k, final.",
  })
);
check(
  "supplier's fourth move is refused (opening ask counts as one)",
  refused(
    await call(supplierA, "propose", {
      match_id: threadA,
      price_eur: 755_000,
      lead_time_days: 56,
      message: "x",
    }),
    "accept or walk away"
  )
);

// --- wait and events ---------------------------------------------------------------------
console.log("\nevents");
const waitedB = result<{ events: { action: string }[]; cursor: number }>(
  await call(supplierB, "wait", { since: 0, timeout_s: 1 })
);
check(
  "supplier B gets its match and nothing from A's thread",
  waitedB.events.some((e) => e.action === "match_opened") &&
    !waitedB.events.some((e) => e.action === "proposed")
);
check("wait returns a cursor", waitedB.cursor > 0);

// --- accept and supersede --------------------------------------------------------------
console.log("\naccept");
const standing = result<{
  threads: {
    match_id: string;
    turn: string | null;
    proposals: { by: string }[];
  }[];
}>(await call(buyer, "my_market")).threads.find((t) => t.match_id === threadA);
const lastBy = standing?.proposals.at(-1)?.by;
const acceptor = lastBy === "buyer" ? supplierA : buyer;
const agreed = result<{
  state: string;
  price_eur: number;
  superseded: string[];
}>(await call(acceptor, "accept", { match_id: threadA }));
check("thread A agreed", agreed.state === "agreed", agreed);
check(
  "thread B superseded",
  agreed.superseded.includes(threadB),
  agreed.superseded
);
check(
  "closed thread refuses further moves",
  refused(
    await call(buyer, "walk_away", { match_id: threadB, reason: "x" }),
    "superseded"
  )
);
const after = result<{
  demands: { state: string }[];
  offers: { state: string }[];
}>(await call(observer, "my_market"));
check("demand filled", after.demands[0]?.state === "filled");
check(
  "offer A filled, offer B still open",
  after.offers.filter((o) => o.state === "filled").length === 1 &&
    after.offers.filter((o) => o.state === "open").length === 1,
  after.offers.map((o) => o.state)
);
const feed = result<{ events: { action: string; sealed?: unknown }[] }>(
  await call(observer, "wait", { since: 0, timeout_s: 1 })
);
check(
  "observer feed has the full story with sealed values",
  [
    "offer_posted",
    "demand_posted",
    "match_opened",
    "proposed",
    "agreed",
    "superseded",
  ].every((a) => feed.events.some((e) => e.action === a)) &&
    feed.events.some((e) => e.sealed !== undefined && e.sealed !== null)
);

console.log(
  `\n${failures === 0 ? "ALL OK" : `${failures} FAILED`}: agreed at ${agreed.price_eur} EUR, ${feed.events.length} events`
);
process.exit(failures === 0 ? 0 : 1);
