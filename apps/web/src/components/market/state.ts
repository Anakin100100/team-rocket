// The admin UI's view of the market, rebuilt from the event log alone
// (plan.md §6): the same reducer drives the live view and the replay.
import type { client } from "@/utils/orpc";

export type MarketEvent = Awaited<
  ReturnType<typeof client.market.events>
>["events"][number];

export type ThreadState = "open" | "agreed" | "abandoned" | "superseded";
export type PostingState = "open" | "filled" | "withdrawn";
export type Side = "buyer" | "supplier";

export interface Demand {
  id: string;
  buyerId: string | null;
  buyerName: string | null;
  buyerCountry: string | null;
  listingId: string;
  title: string;
  titleEn: string | null;
  need: string;
  cpv: string;
  valueEur: number | null;
  deadline: string | null;
  url: string | null;
  fetchedAt: string | null;
  walkAwayEur: number | null;
  state: "open" | "filled" | "withdrawn";
}

export interface Offer {
  id: string;
  supplierId: string | null;
  supplierName: string;
  cpvClass: string;
  askEur: number;
  leadTimeDays: number;
  note: string;
  floorEur: number | null;
  state: "open" | "filled" | "withdrawn";
}

export interface Proposal {
  move: number;
  by: Side;
  priceEur: number;
  leadTimeDays: number;
  message: string;
  cites: string[];
  at: string;
}

export interface Thread {
  id: string;
  demandId: string | null;
  offerId: string | null;
  supplierId: string | null;
  supplierName: string;
  supplierCountry: string;
  tier: number;
  winsInCpv: number;
  state: ThreadState;
  turn: Side | null;
  proposals: Proposal[];
  threadFloorEur: number | null;
  walkAwayEur: number | null;
  agreed: {
    priceEur: number;
    leadTimeDays: number;
    by: Side;
    at: string;
  } | null;
  closedReason: string | null;
  closedBy: Side | null;
  updatedAt: string;
}

export interface MarketView {
  demands: Map<string, Demand>;
  offers: Map<string, Offer>;
  threads: Map<string, Thread>;
}

type Payload = Record<string, unknown>;

const str = (value: unknown) => (typeof value === "string" ? value : null);
const num = (value: unknown) => (typeof value === "number" ? value : null);

type Handler = (
  view: MarketView,
  event: MarketEvent,
  payload: Payload,
  sealed: Payload
) => void;

const onDemandPosted: Handler = (view, event, payload, sealed) => {
  if (!event.demand_id) {
    return;
  }
  view.demands.set(event.demand_id, {
    id: event.demand_id,
    buyerId: event.buyer_id,
    buyerName: str(payload.buyer_name),
    buyerCountry: str(payload.buyer_country),
    listingId: str(payload.listing_id) ?? "",
    title: str(payload.listing_title) ?? "",
    titleEn: str(payload.listing_title_en),
    need: str(payload.need) ?? "",
    cpv: str(payload.cpv) ?? "",
    valueEur: num(payload.estimated_value_eur),
    deadline: str(payload.deadline),
    url: str(payload.url),
    fetchedAt: str(payload.fetched_at),
    walkAwayEur: num(sealed.walk_away_eur),
    state: "open",
  });
};

const onOfferPosted: Handler = (view, event, payload, sealed) => {
  if (!event.offer_id) {
    return;
  }
  view.offers.set(event.offer_id, {
    id: event.offer_id,
    supplierId: event.supplier_id,
    supplierName: str(payload.supplier_name) ?? event.supplier_id ?? "",
    cpvClass: str(payload.cpv_class) ?? "",
    askEur: num(payload.ask_eur) ?? 0,
    leadTimeDays: num(payload.lead_time_days) ?? 0,
    note: str(payload.note) ?? "",
    floorEur: num(sealed.floor_eur),
    state: "open",
  });
};

const onMatchOpened: Handler = (view, event, payload, sealed) => {
  if (!event.match_id) {
    return;
  }
  view.threads.set(event.match_id, {
    id: event.match_id,
    demandId: event.demand_id,
    offerId: event.offer_id,
    supplierId: event.supplier_id,
    supplierName: str(payload.supplier_name) ?? event.supplier_id ?? "",
    supplierCountry: str(payload.supplier_country) ?? "",
    tier: num(payload.tier) ?? 0,
    winsInCpv: num(payload.wins_in_matched_cpv) ?? 0,
    state: "open",
    turn: "buyer",
    // The supplier's public ask is the thread's first proposal.
    proposals: [
      {
        move: 1,
        by: "supplier",
        priceEur: num(payload.opening_ask_eur) ?? 0,
        leadTimeDays: num(payload.lead_time_days) ?? 0,
        message: str(payload.message) ?? "",
        cites: [],
        at: event.ts,
      },
    ],
    threadFloorEur: num(sealed.thread_floor_eur),
    walkAwayEur: num(sealed.walk_away_eur),
    agreed: null,
    closedReason: null,
    closedBy: null,
    updatedAt: event.ts,
  });
};

const side = (value: unknown): Side =>
  value === "buyer" ? "buyer" : "supplier";

const citesOf = (value: unknown) =>
  Array.isArray(value)
    ? value.filter((cite): cite is string => typeof cite === "string")
    : [];

const onProposed: Handler = (view, event, payload) => {
  const thread = event.match_id ? view.threads.get(event.match_id) : undefined;
  if (!thread) {
    return;
  }
  thread.proposals.push({
    move: num(payload.move) ?? thread.proposals.length + 1,
    by: side(payload.by),
    priceEur: num(payload.price_eur) ?? 0,
    leadTimeDays: num(payload.lead_time_days) ?? 0,
    message: str(payload.message) ?? "",
    cites: citesOf(payload.cites),
    at: event.ts,
  });
  thread.turn = side(payload.turn);
  thread.updatedAt = event.ts;
};

const onAgreed: Handler = (view, event, payload, sealed) => {
  const thread = event.match_id ? view.threads.get(event.match_id) : undefined;
  if (!thread) {
    return;
  }
  thread.state = "agreed";
  thread.turn = null;
  thread.agreed = {
    priceEur: num(payload.price_eur) ?? 0,
    leadTimeDays: num(payload.lead_time_days) ?? 0,
    by: side(payload.accepted_by),
    at: event.ts,
  };
  thread.threadFloorEur ??= num(sealed.thread_floor_eur);
  thread.walkAwayEur ??= num(sealed.walk_away_eur);
  thread.updatedAt = event.ts;
  const demand = event.demand_id
    ? view.demands.get(event.demand_id)
    : undefined;
  const offer = event.offer_id ? view.offers.get(event.offer_id) : undefined;
  if (demand) {
    demand.state = "filled";
  }
  if (offer) {
    offer.state = "filled";
  }
};

const closeWith =
  (state: "abandoned" | "superseded"): Handler =>
  (view, event, payload) => {
    const thread = event.match_id
      ? view.threads.get(event.match_id)
      : undefined;
    if (!thread) {
      return;
    }
    thread.state = state;
    thread.turn = null;
    thread.closedReason = str(payload.reason);
    thread.closedBy =
      payload.by === "buyer" || payload.by === "supplier" ? payload.by : null;
    thread.updatedAt = event.ts;
  };

// A withdrawn posting's threads close through their own walked_away events.
const onDemandWithdrawn: Handler = (view, event) => {
  const demand = event.demand_id
    ? view.demands.get(event.demand_id)
    : undefined;
  if (demand) {
    demand.state = "withdrawn";
  }
};

const onOfferWithdrawn: Handler = (view, event) => {
  const offer = event.offer_id ? view.offers.get(event.offer_id) : undefined;
  if (offer) {
    offer.state = "withdrawn";
  }
};

const HANDLERS: Record<string, Handler> = {
  demand_posted: onDemandPosted,
  offer_posted: onOfferPosted,
  match_opened: onMatchOpened,
  proposed: onProposed,
  agreed: onAgreed,
  walked_away: closeWith("abandoned"),
  superseded: closeWith("superseded"),
  demand_withdrawn: onDemandWithdrawn,
  offer_withdrawn: onOfferWithdrawn,
};

export const buildView = (events: readonly MarketEvent[]): MarketView => {
  const view: MarketView = {
    demands: new Map(),
    offers: new Map(),
    threads: new Map(),
  };
  for (const event of events) {
    HANDLERS[event.action]?.(
      view,
      event,
      event.payload as Payload,
      (event.sealed ?? {}) as Payload
    );
  }
  return view;
};

const EUR = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "EUR",
  maximumFractionDigits: 0,
});
const EUR_SHORT = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "EUR",
  notation: "compact",
  maximumFractionDigits: 1,
});

export const formatEur = (value: number | null | undefined) =>
  value === null || value === undefined ? "—" : EUR.format(value);
export const formatEurShort = (value: number | null | undefined) =>
  value === null || value === undefined ? "—" : EUR_SHORT.format(value);

const TIME = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});
const DATE_TIME = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});
export const formatTime = (iso: string) => TIME.format(new Date(iso));
export const formatDateTime = (iso: string) => DATE_TIME.format(new Date(iso));
