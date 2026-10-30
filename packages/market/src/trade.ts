// The five write verbs (plan.md §4.1, §4.4–4.5). Each runs in one transaction,
// locks the rows it changes (demand, then offer, then match, always in that
// order), checks its guards and appends one event per party it concerns.
import {
  buyers,
  demands,
  listings,
  matches,
  offers,
  proposals,
  supplierOfferBasis,
  suppliers,
} from "@rocket/db/schema/market";
import { and, asc, desc, eq, ne, sql } from "drizzle-orm";

import {
  MAX_PROPOSALS_PER_SIDE,
  OUTSIDE_LIMIT,
  WALK_AWAY_FACTOR,
} from "./constants";
import type { Side } from "./constants";
import type { Actor, MarketContext } from "./context";
import { actorLabel } from "./context";
import { forbidden, guardFailed, notFound } from "./errors";
import { appendEvent } from "./events";
import { matchNewDemand, matchNewOffer } from "./matching";

type Tx = Parameters<Parameters<MarketContext["db"]["transaction"]>[0]>[0];

const requireKind = (actor: Actor, kind: Side) => {
  if (actor.kind !== kind || !actor.entityId) {
    throw forbidden(`Only a ${kind} can do this; you are ${actor.kind}.`);
  }
  return actor.entityId;
};

const otherSide = (side: Side): Side =>
  side === "buyer" ? "supplier" : "buyer";

// --- Postings -----------------------------------------------------------------------

export const postDemand = (
  { db }: MarketContext,
  actor: Actor,
  { listingId, need }: { listingId: string; need?: string }
) =>
  db.transaction(async (tx) => {
    const buyerId = requireKind(actor, "buyer");
    const [listing] = await tx
      .select({
        listing: listings,
        isOpen: sql<boolean>`${listings.deadline} >= current_date`,
      })
      .from(listings)
      .where(eq(listings.id, listingId));
    if (!listing) {
      throw notFound(`Listing ${listingId} does not exist.`);
    }
    if (listing.listing.buyerId !== buyerId) {
      throw forbidden(`Listing ${listingId} belongs to another buyer.`);
    }
    if (!listing.isOpen) {
      throw guardFailed(`Listing ${listingId} is closed (deadline passed).`);
    }
    const [existing] = await tx
      .select({ id: demands.id })
      .from(demands)
      .where(and(eq(demands.listingId, listingId), eq(demands.state, "open")));
    if (existing) {
      throw guardFailed(
        `You already have an open demand for this listing (${existing.id}).`
      );
    }
    const { listing: row } = listing;
    const walkAway =
      row.walkAwayEur ?? (row.estimatedValueEur ?? 0) * WALK_AWAY_FACTOR;
    const [demand] = await tx
      .insert(demands)
      .values({
        listingId,
        buyerId,
        cpv: row.mainCpv,
        need: need?.trim() || row.need || row.titleEn || row.title,
        estimatedValueEur: row.estimatedValueEur,
        walkAwayEur: walkAway,
        state: "open",
      })
      .returning();
    if (!demand) {
      throw new Error("Demand insert returned no row.");
    }
    await appendEvent(tx, {
      actor: actorLabel(actor),
      action: "demand_posted",
      demandId: demand.id,
      buyerId,
      payload: {
        listing_id: listingId,
        listing_title: row.title,
        listing_title_en: row.titleEn,
        cpv: demand.cpv,
        need: demand.need,
        estimated_value_eur: demand.estimatedValueEur,
        deadline: row.deadline,
        url: row.url,
      },
      sealed: { walk_away_eur: walkAway },
    });
    const opened = await matchNewDemand(tx, demand.id);
    return {
      demand_id: demand.id,
      state: demand.state,
      need: demand.need,
      matches_opened: opened,
    };
  });

export const postOffer = (
  { db }: MarketContext,
  actor: Actor,
  {
    cpvClass,
    askEur,
    leadTimeDays,
    note,
  }: { cpvClass: string; askEur: number; leadTimeDays: number; note: string }
) =>
  db.transaction(async (tx) => {
    const supplierId = requireKind(actor, "supplier");
    const [basis] = await tx
      .select()
      .from(supplierOfferBasis)
      .where(
        and(
          eq(supplierOfferBasis.supplierId, supplierId),
          eq(supplierOfferBasis.cpvClass, cpvClass)
        )
      );
    if (!basis) {
      throw guardFailed(
        `You have no public awards in CPV class ${cpvClass}; offer only in classes you have won in (see whoami).`
      );
    }
    const [existing] = await tx
      .select({ id: offers.id })
      .from(offers)
      .where(
        and(
          eq(offers.supplierId, supplierId),
          eq(offers.cpvClass, cpvClass),
          eq(offers.state, "open")
        )
      );
    if (existing) {
      throw guardFailed(
        `You already have an open offer in class ${cpvClass} (${existing.id}).`
      );
    }
    if (askEur < basis.floorEur) {
      throw guardFailed(`Ask is ${OUTSIDE_LIMIT}.`);
    }
    const [offer] = await tx
      .insert(offers)
      .values({
        supplierId,
        cpvClass,
        cpvCodes: basis.cpvCodes,
        askEur,
        leadTimeDays,
        note,
        floorEur: basis.floorEur,
        state: "open",
      })
      .returning();
    if (!offer) {
      throw new Error("Offer insert returned no row.");
    }
    await appendEvent(tx, {
      actor: actorLabel(actor),
      action: "offer_posted",
      offerId: offer.id,
      supplierId,
      payload: {
        supplier_name: actor.name,
        cpv_class: cpvClass,
        cpv_codes: basis.cpvCodes,
        ask_eur: askEur,
        lead_time_days: leadTimeDays,
        note,
      },
      sealed: { floor_eur: basis.floorEur },
    });
    const opened = await matchNewOffer(tx, offer.id);
    return {
      offer_id: offer.id,
      state: offer.state,
      matches_opened: opened,
    };
  });

// --- Threads ------------------------------------------------------------------------

interface Thread {
  match: typeof matches.$inferSelect;
  demand: typeof demands.$inferSelect;
  offer: typeof offers.$inferSelect;
  side: Side;
}

// Locks demand, then offer, then match, and checks that the actor is a party.
const lockThread = async (
  tx: Tx,
  actor: Actor,
  matchId: string
): Promise<Thread> => {
  const [ids] = await tx
    .select({ demandId: matches.demandId, offerId: matches.offerId })
    .from(matches)
    .where(eq(matches.id, matchId));
  if (!ids) {
    throw notFound(`Match ${matchId} does not exist.`);
  }
  const [demand] = await tx
    .select()
    .from(demands)
    .where(eq(demands.id, ids.demandId))
    .for("update");
  const [offer] = await tx
    .select()
    .from(offers)
    .where(eq(offers.id, ids.offerId))
    .for("update");
  const [match] = await tx
    .select()
    .from(matches)
    .where(eq(matches.id, matchId))
    .for("update");
  if (!(demand && offer && match)) {
    throw notFound(`Match ${matchId} does not exist.`);
  }
  let side: Side | null = null;
  if (actor.kind === "buyer" && actor.entityId === demand.buyerId) {
    side = "buyer";
  } else if (actor.kind === "supplier" && actor.entityId === offer.supplierId) {
    side = "supplier";
  }
  if (!side) {
    throw forbidden(`You are not a party to match ${matchId}.`);
  }
  if (match.state !== "open") {
    throw guardFailed(`This thread is ${match.state}.`);
  }
  return { match, demand, offer, side };
};

const threadProposals = (tx: Tx, matchId: string) =>
  tx
    .select()
    .from(proposals)
    .where(eq(proposals.matchId, matchId))
    .orderBy(asc(proposals.id));

const parties = (thread: Thread) => ({
  matchId: thread.match.id,
  demandId: thread.demand.id,
  offerId: thread.offer.id,
  buyerId: thread.demand.buyerId,
  supplierId: thread.offer.supplierId,
});

export const propose = (
  { db }: MarketContext,
  actor: Actor,
  {
    matchId,
    priceEur,
    leadTimeDays,
    message,
    cites,
  }: {
    matchId: string;
    priceEur: number;
    leadTimeDays: number;
    message: string;
    cites: string[];
  }
) =>
  db.transaction(async (tx) => {
    const thread = await lockThread(tx, actor, matchId);
    const { match, demand, side } = thread;
    if (match.turn !== side) {
      throw guardFailed("It is not your turn; wait for the other side.");
    }
    const history = await threadProposals(tx, matchId);
    const mine = history.filter((proposal) => proposal.by === side);
    if (mine.length >= MAX_PROPOSALS_PER_SIDE) {
      throw guardFailed(
        `You have made ${MAX_PROPOSALS_PER_SIDE} proposals; you can only accept or walk away.`
      );
    }
    const last = mine.at(-1);
    if (last && side === "buyer" && priceEur < last.priceEur) {
      throw guardFailed(
        `A buyer can only concede: your last proposal was ${last.priceEur} EUR.`
      );
    }
    if (last && side === "supplier" && priceEur > last.priceEur) {
      throw guardFailed(
        `A supplier can only concede: your last proposal was ${last.priceEur} EUR.`
      );
    }
    if (side === "buyer" && priceEur > demand.walkAwayEur) {
      throw guardFailed(`Price is ${OUTSIDE_LIMIT}.`);
    }
    if (side === "supplier" && priceEur < match.floorEur) {
      throw guardFailed(`Price is ${OUTSIDE_LIMIT}.`);
    }
    const [proposal] = await tx
      .insert(proposals)
      .values({ matchId, by: side, priceEur, leadTimeDays, message, cites })
      .returning();
    const next = otherSide(side);
    await tx.update(matches).set({ turn: next }).where(eq(matches.id, matchId));
    const moveNumber = history.length + 1;
    await appendEvent(tx, {
      actor: actorLabel(actor),
      action: "proposed",
      ...parties(thread),
      payload: {
        by: side,
        move: moveNumber,
        price_eur: priceEur,
        lead_time_days: leadTimeDays,
        message,
        cites,
        turn: next,
        proposals_left: MAX_PROPOSALS_PER_SIDE - mine.length - 1,
      },
    });
    return {
      proposal_id: proposal?.id,
      match_id: matchId,
      move: moveNumber,
      turn: next,
      your_proposals_left: MAX_PROPOSALS_PER_SIDE - mine.length - 1,
    };
  });

export const accept = (
  { db }: MarketContext,
  actor: Actor,
  { matchId }: { matchId: string }
) =>
  db.transaction(async (tx) => {
    const thread = await lockThread(tx, actor, matchId);
    const { match, demand, offer, side } = thread;
    const [standing] = await tx
      .select()
      .from(proposals)
      .where(eq(proposals.matchId, matchId))
      .orderBy(desc(proposals.id))
      .limit(1);
    if (!standing || standing.by === side) {
      throw guardFailed(
        "There is no standing proposal from the other side to accept."
      );
    }
    if (side === "buyer" && standing.priceEur > demand.walkAwayEur) {
      throw guardFailed(`That price is ${OUTSIDE_LIMIT}.`);
    }
    if (side === "supplier" && standing.priceEur < match.floorEur) {
      throw guardFailed(`That price is ${OUTSIDE_LIMIT}.`);
    }
    if (demand.state !== "open" || offer.state !== "open") {
      throw guardFailed("The demand or the offer has already been filled.");
    }

    const closedAt = new Date();
    await tx
      .update(matches)
      .set({
        state: "agreed",
        agreedPriceEur: standing.priceEur,
        agreedLeadTimeDays: standing.leadTimeDays,
        closedAt,
      })
      .where(eq(matches.id, matchId));
    await tx
      .update(demands)
      .set({ state: "filled" })
      .where(eq(demands.id, demand.id));
    await tx
      .update(offers)
      .set({ state: "filled" })
      .where(eq(offers.id, offer.id));

    const { length: moveCount } = await threadProposals(tx, matchId);
    const [names] = await tx
      .select({
        buyer: buyers.name,
        supplier: suppliers.name,
        listing: listings.title,
      })
      .from(demands)
      .innerJoin(buyers, eq(buyers.id, demands.buyerId))
      .innerJoin(listings, eq(listings.id, demands.listingId))
      .innerJoin(suppliers, eq(suppliers.id, offer.supplierId))
      .where(eq(demands.id, demand.id));
    await appendEvent(tx, {
      actor: actorLabel(actor),
      action: "agreed",
      ...parties(thread),
      payload: {
        accepted_by: side,
        price_eur: standing.priceEur,
        lead_time_days: standing.leadTimeDays,
        buyer_name: names?.buyer,
        supplier_name: names?.supplier,
        listing_title: names?.listing,
        moves: moveCount + 1,
      },
      sealed: {
        thread_floor_eur: match.floorEur,
        walk_away_eur: demand.walkAwayEur,
      },
    });

    // The buyer's other threads on this demand, and the supplier's other
    // threads on this offer, are superseded.
    const others = await tx
      .select({ match: matches, demand: demands, offer: offers })
      .from(matches)
      .innerJoin(demands, eq(demands.id, matches.demandId))
      .innerJoin(offers, eq(offers.id, matches.offerId))
      .where(
        and(
          eq(matches.state, "open"),
          ne(matches.id, matchId),
          sql`(${matches.demandId} = ${demand.id} or ${matches.offerId} = ${offer.id})`
        )
      );
    for (const other of others) {
      // oxlint-disable-next-line no-await-in-loop
      await tx
        .update(matches)
        .set({
          state: "superseded",
          closedAt,
          closedReason: "Another thread agreed.",
        })
        .where(eq(matches.id, other.match.id));
      // oxlint-disable-next-line no-await-in-loop
      await appendEvent(tx, {
        actor: "market",
        action: "superseded",
        matchId: other.match.id,
        demandId: other.demand.id,
        offerId: other.offer.id,
        buyerId: other.demand.buyerId,
        supplierId: other.offer.supplierId,
        payload: {
          reason: "Another thread agreed first.",
          agreed_match_id: matchId,
        },
      });
    }
    return {
      match_id: matchId,
      state: "agreed",
      price_eur: standing.priceEur,
      lead_time_days: standing.leadTimeDays,
      superseded: others.map((other) => other.match.id),
    };
  });

export const walkAway = (
  { db }: MarketContext,
  actor: Actor,
  { matchId, reason }: { matchId: string; reason: string }
) =>
  db.transaction(async (tx) => {
    const thread = await lockThread(tx, actor, matchId);
    await tx
      .update(matches)
      .set({ state: "abandoned", closedAt: new Date(), closedReason: reason })
      .where(eq(matches.id, matchId));
    await appendEvent(tx, {
      actor: actorLabel(actor),
      action: "walked_away",
      ...parties(thread),
      payload: { by: thread.side, reason },
    });
    return { match_id: matchId, state: "abandoned" };
  });
