// The write verbs (plan.md §4.1, §4.4–4.5). Each runs in one transaction
// behind the market write lock (write.ts), locks the rows it changes (demand,
// then offer, then match, always in that order), checks its guards and appends
// one event per party it concerns.
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
import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";

import {
  MAX_PROPOSALS_PER_SIDE,
  OUTSIDE_LIMIT,
  USER_LISTING_PREFIX,
  WALK_AWAY_FACTOR,
} from "./constants";
import type { Side } from "./constants";
import type { Actor, MarketContext } from "./context";
import { actorLabel, actsAs } from "./context";
import { forbidden, guardFailed, notFound } from "./errors";
import { appendEvent } from "./events";
import { matchNewDemand, matchNewOffer } from "./matching";
import { traderLimits } from "./traders";
import { marketWrite } from "./write";
import type { Tx } from "./write";

const requireSide = (actor: Actor, side: Side) => {
  if (!actsAs(actor, side)) {
    throw forbidden(`Only a ${side} can do this; you are ${actor.kind}.`);
  }
  if (!actor.entityId) {
    throw guardFailed("Name the company you trade as first (set_company).");
  }
  return actor.entityId;
};

const isOpenListing = sql<boolean>`${listings.deadline} >= current_date`;

const otherSide = (side: Side): Side =>
  side === "buyer" ? "supplier" : "buyer";

// --- Postings -----------------------------------------------------------------------

// A demand of the buyer's own, when there is no published listing to post.
export interface OwnListing {
  title: string;
  cpv: string;
  estimatedValueEur: number;
  deadline: string;
}

const insertOwnListing = async (
  tx: Tx,
  buyerId: string,
  { title, cpv, estimatedValueEur, deadline }: OwnListing,
  need?: string
) => {
  const externalId = crypto.randomUUID();
  const listingId = `${USER_LISTING_PREFIX}${externalId}`;
  await tx.insert(listings).values({
    id: listingId,
    externalId,
    buyerId,
    mainCpv: cpv,
    cpvCodes: [cpv],
    title,
    titleEn: title,
    need: need?.trim() || title,
    language: "en",
    deadline,
    estimatedValueEur,
    fetchedAt: new Date(),
  });
  return listingId;
};

// The listing a new demand is for: the buyer's own, open, and neither on the
// market already nor bought before.
const postableListing = async (tx: Tx, buyerId: string, listingId: string) => {
  const [listing] = await tx
    .select({ row: listings, isOpen: isOpenListing })
    .from(listings)
    .where(eq(listings.id, listingId));
  if (!listing) {
    throw notFound(`Listing ${listingId} does not exist.`);
  }
  if (listing.row.buyerId !== buyerId) {
    throw forbidden(`Listing ${listingId} belongs to another buyer.`);
  }
  if (!listing.isOpen) {
    throw guardFailed(`Listing ${listingId} is closed (deadline passed).`);
  }
  const [existing] = await tx
    .select({ id: demands.id, state: demands.state })
    .from(demands)
    .where(
      and(
        eq(demands.listingId, listingId),
        inArray(demands.state, ["open", "filled"])
      )
    );
  if (existing?.state === "open") {
    throw guardFailed(
      `You already have an open demand for this listing (${existing.id}).`
    );
  }
  if (existing) {
    throw guardFailed(
      `This listing was already bought (demand ${existing.id}).`
    );
  }
  return listing.row;
};

// A user's walk-away comes from their own limit; a persona's from the
// listing's sealed one, else the published value.
const walkAwayFor = async (
  tx: Tx,
  actor: Actor,
  listing: typeof listings.$inferSelect
) => {
  const limits = await traderLimits(tx, actor);
  const value = listing.estimatedValueEur ?? 0;
  const walkAway = limits
    ? value * limits.walkAwayFactor
    : (listing.walkAwayEur ?? value * WALK_AWAY_FACTOR);
  if (!(walkAway > 0)) {
    throw guardFailed(
      `Listing ${listing.id} has no published value, so there is no walk-away limit to trade under.`
    );
  }
  return walkAway;
};

export const postDemand = (
  { db }: MarketContext,
  actor: Actor,
  {
    listingId: givenListingId,
    need,
    own,
  }: { listingId?: string; need?: string; own?: OwnListing }
) =>
  marketWrite(db, async (tx) => {
    const buyerId = requireSide(actor, "buyer");
    let listingId = givenListingId;
    if (!listingId) {
      if (!own) {
        throw new Error(
          "post_demand needs a listing id or a listing of its own."
        );
      }
      listingId = await insertOwnListing(tx, buyerId, own, need);
    }
    const row = await postableListing(tx, buyerId, listingId);
    const walkAway = await walkAwayFor(tx, actor, row);
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
    const [buyer] = await tx
      .select({ name: buyers.name, country: buyers.country })
      .from(buyers)
      .where(eq(buyers.id, buyerId));
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
        buyer_name: buyer?.name ?? null,
        buyer_country: buyer?.country ?? null,
        fetched_at: row.fetchedAt.toISOString(),
      },
      sealed: { walk_away_eur: walkAway },
    });
    const opened = await matchNewDemand(tx, demand.id);
    return {
      demand_id: demand.id,
      listing_id: listingId,
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
  marketWrite(db, async (tx) => {
    const supplierId = requireSide(actor, "supplier");
    const [basis] = await tx
      .select()
      .from(supplierOfferBasis)
      .where(
        and(
          eq(supplierOfferBasis.supplierId, supplierId),
          eq(supplierOfferBasis.cpvClass, cpvClass)
        )
      );
    // A user may offer in any class, with the floor they set on their ask; a
    // persona only where it has won, with the floor its record gives.
    const limits = await traderLimits(tx, actor);
    let floor: number;
    if (limits) {
      floor = askEur * limits.floorFactor;
    } else if (basis) {
      floor = basis.floorEur;
    } else {
      throw guardFailed(
        `You have no public awards in CPV class ${cpvClass}; offer only in classes you have won in (see whoami).`
      );
    }
    const cpvCodes = basis?.cpvCodes ?? [];
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
    if (askEur < floor) {
      throw guardFailed(`Ask is ${OUTSIDE_LIMIT}.`);
    }
    const [offer] = await tx
      .insert(offers)
      .values({
        supplierId,
        cpvClass,
        cpvCodes,
        askEur,
        leadTimeDays,
        note,
        floorEur: floor,
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
        cpv_codes: cpvCodes,
        ask_eur: askEur,
        lead_time_days: leadTimeDays,
        note,
      },
      sealed: { floor_eur: floor },
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
  // false once the listing's deadline has passed: only walk_away is left
  listingOpen: boolean;
}

// Locks demand, then offer, then match, and checks that the actor is a party.
// A trader's side follows from which end of the thread holds its id; matching
// never pairs a company with itself.
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
  if (actsAs(actor, "buyer") && actor.entityId === demand.buyerId) {
    side = "buyer";
  } else if (actsAs(actor, "supplier") && actor.entityId === offer.supplierId) {
    side = "supplier";
  }
  if (!side) {
    throw forbidden(`You are not a party to match ${matchId}.`);
  }
  if (match.state !== "open") {
    throw guardFailed(`This thread is ${match.state}.`);
  }
  const [listing] = await tx
    .select({ isOpen: isOpenListing })
    .from(listings)
    .where(eq(listings.id, demand.listingId));
  return { match, demand, offer, side, listingOpen: Boolean(listing?.isOpen) };
};

const requireOpenListing = (thread: Thread) => {
  if (!thread.listingOpen) {
    throw guardFailed(
      "The listing's deadline has passed; you can only walk away."
    );
  }
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
  marketWrite(db, async (tx) => {
    const thread = await lockThread(tx, actor, matchId);
    requireOpenListing(thread);
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
  marketWrite(db, async (tx) => {
    const thread = await lockThread(tx, actor, matchId);
    requireOpenListing(thread);
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
  marketWrite(db, async (tx) => {
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

// Takes an open demand or offer off the market. Its open threads are
// abandoned, and each counterparty reads why.
export const withdraw = (
  { db }: MarketContext,
  actor: Actor,
  { postingId, reason }: { postingId: string; reason: string }
) =>
  marketWrite(db, async (tx) => {
    const [demand] = await tx
      .select()
      .from(demands)
      .where(eq(demands.id, postingId))
      .for("update");
    const [offer] = demand
      ? []
      : await tx
          .select()
          .from(offers)
          .where(eq(offers.id, postingId))
          .for("update");
    let posting: { kind: string; side: Side; owner: string; state: string };
    if (demand) {
      posting = {
        kind: "demand",
        side: "buyer",
        owner: demand.buyerId,
        state: demand.state,
      };
    } else if (offer) {
      posting = {
        kind: "offer",
        side: "supplier",
        owner: offer.supplierId,
        state: offer.state,
      };
    } else {
      throw notFound(`No demand or offer with id ${postingId}.`);
    }
    if (!actsAs(actor, posting.side) || actor.entityId !== posting.owner) {
      throw forbidden(`This ${posting.kind} is not yours.`);
    }
    if (posting.state !== "open") {
      throw guardFailed(`This ${posting.kind} is ${posting.state}.`);
    }
    await (demand
      ? tx
          .update(demands)
          .set({ state: "withdrawn" })
          .where(eq(demands.id, postingId))
      : tx
          .update(offers)
          .set({ state: "withdrawn" })
          .where(eq(offers.id, postingId)));
    await appendEvent(tx, {
      actor: actorLabel(actor),
      action: `${posting.kind}_withdrawn`,
      demandId: demand?.id,
      offerId: offer?.id,
      buyerId: demand?.buyerId,
      supplierId: offer?.supplierId,
      payload: { reason },
    });

    const open = await tx
      .select({ match: matches, demand: demands, offer: offers })
      .from(matches)
      .innerJoin(demands, eq(demands.id, matches.demandId))
      .innerJoin(offers, eq(offers.id, matches.offerId))
      .where(
        and(
          eq(matches.state, "open"),
          demand
            ? eq(matches.demandId, postingId)
            : eq(matches.offerId, postingId)
        )
      )
      .orderBy(asc(matches.id));
    const closedAt = new Date();
    const closedReason = `Withdrew the ${posting.kind}: ${reason}`;
    for (const thread of open) {
      // oxlint-disable-next-line no-await-in-loop
      await tx
        .update(matches)
        .set({ state: "abandoned", closedAt, closedReason })
        .where(eq(matches.id, thread.match.id));
      // oxlint-disable-next-line no-await-in-loop
      await appendEvent(tx, {
        actor: actorLabel(actor),
        action: "walked_away",
        matchId: thread.match.id,
        demandId: thread.demand.id,
        offerId: thread.offer.id,
        buyerId: thread.demand.buyerId,
        supplierId: thread.offer.supplierId,
        payload: { by: posting.side, reason: closedReason },
      });
    }
    return {
      posting_id: postingId,
      state: "withdrawn",
      threads_closed: open.map((thread) => thread.match.id),
    };
  });
