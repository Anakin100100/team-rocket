// Signed-in users as traders (plan.md §5.1): the company they trade as and
// the sealed limits they set themselves. Users are trusted: entering a company
// number claims that public record, unless an agent persona or another user
// already holds it.
import {
  awards,
  buyers,
  demands,
  marketAgents,
  marketTraders,
  offers,
  suppliers,
} from "@rocket/db/schema/market";
import { and, count, eq, like, ne, or } from "drizzle-orm";

import {
  TED_BUYER_PREFIX,
  USER_ENTITY_PREFIX,
  USER_FLOOR_FACTOR,
  WALK_AWAY_FACTOR,
} from "./constants";
import type { Actor, Executor, MarketContext } from "./context";
import { forbidden, guardFailed, invalidInput } from "./errors";
import { marketWrite } from "./write";
import type { Tx } from "./write";

const REGISTRY_SEPARATORS = /[\s./-]/gu;
const REGISTRY_DIGITS = /(?:[A-Z]{2})?(?<digits>\d{6,14})/u;
const HEX_ONLY = /^[0-9A-F]+$/u;
const UUID_MIN_LENGTH = 32;
const SIRET_LENGTH = 14;
const SIREN_LENGTH = 9;
const FR_VAT_LENGTH = 11;
const FR_VAT_KEY_LENGTH = 2;
const PERCENT = 100;
// Percentages are shown to one decimal.
const PERCENT_ROUNDING = 10;

// The loader's rule for company numbers (data_discovery/scripts/build_db.py,
// norm_id): bare digits, VAT prefix dropped, French SIRET or VAT cut to the
// SIREN. Supplier ids are `<country>:<these digits>`.
export const normalizeRegistryId = (raw: string, country: string) => {
  const cleaned = raw.toUpperCase().replaceAll(REGISTRY_SEPARATORS, "");
  const digits = REGISTRY_DIGITS.exec(cleaned)?.groups?.digits;
  if (
    !digits ||
    (cleaned.length >= UUID_MIN_LENGTH && HEX_ONLY.test(cleaned))
  ) {
    return "";
  }
  if (country === "FRA" && digits.length === SIRET_LENGTH) {
    return digits.slice(0, SIREN_LENGTH);
  }
  if (country === "FRA" && digits.length === FR_VAT_LENGTH) {
    return digits.slice(FR_VAT_KEY_LENGTH);
  }
  return digits;
};

export interface TraderLimits {
  walkAwayFactor: number;
  floorFactor: number;
}

const DEFAULT_LIMITS: TraderLimits = {
  walkAwayFactor: WALK_AWAY_FACTOR,
  floorFactor: USER_FLOOR_FACTOR,
};

// A trader's own limits (the defaults until set_limits); null for personas,
// whose limits come from their public record.
export const traderLimits = async (
  executor: Executor,
  actor: Actor
): Promise<TraderLimits | null> => {
  if (actor.kind !== "trader" || !actor.userId) {
    return null;
  }
  const [row] = await executor
    .select({
      walkAwayFactor: marketTraders.walkAwayFactor,
      floorFactor: marketTraders.floorFactor,
    })
    .from(marketTraders)
    .where(eq(marketTraders.userId, actor.userId));
  return row ?? DEFAULT_LIMITS;
};

const toPercent = (factor: number) =>
  Math.round(factor * PERCENT * PERCENT_ROUNDING) / PERCENT_ROUNDING;

export const presentLimits = (limits: TraderLimits) => ({
  walk_away_pct: toPercent(limits.walkAwayFactor),
  floor_pct: toPercent(limits.floorFactor),
});

// The actor a signed-in user is, resolved on every request: their company
// once they have named one (set_company), else a trader who can only read.
export const traderActor = async (
  executor: Executor,
  userId: string,
  userName: string
): Promise<Actor> => {
  const [trader] = await executor
    .select({ entityId: marketTraders.entityId, company: suppliers.name })
    .from(marketTraders)
    .leftJoin(suppliers, eq(suppliers.id, marketTraders.entityId))
    .where(eq(marketTraders.userId, userId));
  return {
    kind: "trader",
    entityId: trader?.entityId ?? null,
    name: trader?.company ?? userName,
    userId,
  };
};

const requireTrader = (actor: Actor) => {
  if (actor.kind !== "trader" || !actor.userId) {
    throw forbidden(
      "Only signed-in users set their company and limits; a persona's are fixed."
    );
  }
  return actor.userId;
};

export const setLimits = (
  { db }: MarketContext,
  actor: Actor,
  { walkAwayPct, floorPct }: { walkAwayPct?: number; floorPct?: number }
) =>
  marketWrite(db, async (tx) => {
    const userId = requireTrader(actor);
    const current = (await traderLimits(tx, actor)) ?? DEFAULT_LIMITS;
    const next: TraderLimits = {
      walkAwayFactor:
        walkAwayPct === undefined
          ? current.walkAwayFactor
          : walkAwayPct / PERCENT,
      floorFactor:
        floorPct === undefined ? current.floorFactor : floorPct / PERCENT,
    };
    await tx
      .insert(marketTraders)
      .values({ userId, ...next })
      .onConflictDoUpdate({
        target: marketTraders.userId,
        set: { ...next, updatedAt: new Date() },
      });
    return {
      your_limits: presentLimits(next),
      applies_to:
        "Demands and offers you post from now on. Open ones keep the limits they were posted with.",
    };
  });

interface PublicRecord {
  id: string;
  name: string;
}

// The public record a company number points at. Supplier ids are
// `<country>:<digits>`; buyer ids carry TED's raw number, so buyers are
// compared after the same normalization.
const findPublicRecord = async (
  tx: Tx,
  country: string,
  digits: string
): Promise<PublicRecord | null> => {
  const [supplier] = await tx
    .select({ id: suppliers.id, name: suppliers.name })
    .from(suppliers)
    .where(eq(suppliers.id, `${country}:${digits}`));
  if (supplier) {
    return supplier;
  }
  const candidates = await tx
    .select({ id: buyers.id, name: buyers.name })
    .from(buyers)
    .where(
      and(eq(buyers.country, country), like(buyers.id, `${TED_BUYER_PREFIX}%`))
    );
  return (
    candidates.find(
      (buyer) =>
        normalizeRegistryId(
          buyer.id.slice(TED_BUYER_PREFIX.length),
          country
        ) === digits
    ) ?? null
  );
};

const hasOpenPostings = async (tx: Tx, entityId: string) => {
  const [demand] = await tx
    .select({ id: demands.id })
    .from(demands)
    .where(and(eq(demands.buyerId, entityId), eq(demands.state, "open")))
    .limit(1);
  const [offer] = await tx
    .select({ id: offers.id })
    .from(offers)
    .where(and(eq(offers.supplierId, entityId), eq(offers.state, "open")))
    .limit(1);
  return Boolean(demand || offer);
};

// Refuses a public record that an agent persona or another user trades as.
const assertClaimable = async (
  tx: Tx,
  record: PublicRecord,
  userId: string
) => {
  const [agent] = await tx
    .select({ name: marketAgents.name })
    .from(marketAgents)
    .where(eq(marketAgents.entityId, record.id));
  if (agent) {
    throw forbidden(
      `${record.name} is played by a market agent and cannot be claimed.`
    );
  }
  const [holder] = await tx
    .select({ userId: marketTraders.userId })
    .from(marketTraders)
    .where(
      and(
        eq(marketTraders.entityId, record.id),
        ne(marketTraders.userId, userId)
      )
    );
  if (holder) {
    throw forbidden(`${record.name} is already claimed by another user.`);
  }
};

export const setCompany = (
  { db }: MarketContext,
  actor: Actor,
  {
    country,
    name,
    registryNumber,
  }: { country: string; name?: string; registryNumber?: string }
) =>
  marketWrite(db, async (tx) => {
    const userId = requireTrader(actor);
    let record: PublicRecord | null = null;
    if (registryNumber) {
      const digits = normalizeRegistryId(registryNumber, country);
      if (!digits) {
        throw invalidInput(
          `${registryNumber} does not look like a VAT or company number.`
        );
      }
      record = await findPublicRecord(tx, country, digits);
    }
    const ownName = name?.trim();
    if (record) {
      await assertClaimable(tx, record, userId);
    } else if (!ownName) {
      throw invalidInput(
        registryNumber
          ? `No public record with number ${registryNumber} in ${country}. Give your company's name to trade under it.`
          : "Give your company's name, or its VAT or company number to claim its public record."
      );
    }
    const entityId = record?.id ?? `${USER_ENTITY_PREFIX}${userId}`;
    const companyName = record?.name ?? ownName ?? "";

    const [current] = await tx
      .select({ entityId: marketTraders.entityId })
      .from(marketTraders)
      .where(eq(marketTraders.userId, userId));
    if (
      current?.entityId &&
      current.entityId !== entityId &&
      (await hasOpenPostings(tx, current.entityId))
    ) {
      throw guardFailed(
        "Withdraw your open demands and offers before you switch company."
      );
    }

    // One id on both sides: create whichever side the company lacks. A user's
    // own company takes the name and country given; a public record keeps its own.
    const row = { id: entityId, name: companyName, country, stats: {} };
    if (record) {
      await tx.insert(buyers).values(row).onConflictDoNothing();
      await tx.insert(suppliers).values(row).onConflictDoNothing();
    } else {
      const update = { name: companyName, country };
      await tx
        .insert(buyers)
        .values(row)
        .onConflictDoUpdate({ target: buyers.id, set: update });
      await tx
        .insert(suppliers)
        .values(row)
        .onConflictDoUpdate({ target: suppliers.id, set: update });
    }
    await tx
      .insert(marketTraders)
      .values({ userId, entityId, ...DEFAULT_LIMITS })
      .onConflictDoUpdate({
        target: marketTraders.userId,
        set: { entityId, updatedAt: new Date() },
      });

    const [history] = await tx
      .select({ n: count() })
      .from(awards)
      .where(or(eq(awards.buyerId, entityId), eq(awards.supplierId, entityId)));
    return {
      company_id: entityId,
      name: companyName,
      country,
      public_record: Boolean(record),
      public_awards: history?.n ?? 0,
      note: record
        ? "You trade as this company: its public awards are your history. You can buy and sell."
        : "You trade as your own company, with no public history yet. You can buy and sell.",
    };
  });
