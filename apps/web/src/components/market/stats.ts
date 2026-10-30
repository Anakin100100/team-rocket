// Aggregates for the dashboard tab, derived from the same rebuilt view (and
// event log) as every other tab, so the numbers move with the feed.
import type {
  MarketEvent,
  MarketView,
  PostingState,
  Side,
  Thread,
  ThreadState,
} from "./state";

export type PostingCounts = Record<PostingState | "total", number>;
export type ThreadCounts = Record<ThreadState | "total", number>;

export interface DealStats {
  count: number;
  valueEur: number;
  // Agreed total against the same demands' published values, e.g. -0.12.
  vsPublished: number | null;
  // Agreed total against the suppliers' opening asks in the same threads.
  vsOpeningAsk: number | null;
  avgMoves: number | null;
  avgDurationMs: number | null;
}

export interface MarketStats {
  demands: PostingCounts;
  offers: PostingCounts;
  threads: ThreadCounts;
  waitingOn: Record<Side, number>;
  moves: number;
  openDemandValueEur: number;
  deals: DealStats;
}

const countPostings = (
  postings: Iterable<{ state: PostingState }>
): PostingCounts => {
  const counts: PostingCounts = { total: 0, open: 0, filled: 0, withdrawn: 0 };
  for (const { state } of postings) {
    counts.total += 1;
    counts[state] += 1;
  }
  return counts;
};

const ratio = (part: number, whole: number) =>
  whole > 0 ? part / whole - 1 : null;
const mean = (values: number[]) =>
  values.length > 0
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;

const dealStats = (view: MarketView, agreed: Thread[]): DealStats => {
  let valueEur = 0;
  let agreedWithPublished = 0;
  let published = 0;
  let openingAsks = 0;
  const moves: number[] = [];
  const durations: number[] = [];
  for (const thread of agreed) {
    const price = thread.agreed?.priceEur ?? 0;
    valueEur += price;
    const demandValue = thread.demandId
      ? view.demands.get(thread.demandId)?.valueEur
      : null;
    if (demandValue) {
      agreedWithPublished += price;
      published += demandValue;
    }
    const [opening] = thread.proposals;
    openingAsks += opening?.priceEur ?? price;
    moves.push(thread.proposals.length);
    if (opening && thread.agreed) {
      durations.push(Date.parse(thread.agreed.at) - Date.parse(opening.at));
    }
  }
  return {
    count: agreed.length,
    valueEur,
    vsPublished: ratio(agreedWithPublished, published),
    vsOpeningAsk: ratio(valueEur, openingAsks),
    avgMoves: mean(moves),
    avgDurationMs: mean(durations),
  };
};

export const computeStats = (view: MarketView): MarketStats => {
  const threads: ThreadCounts = {
    total: 0,
    open: 0,
    agreed: 0,
    abandoned: 0,
    superseded: 0,
  };
  const waitingOn: Record<Side, number> = { buyer: 0, supplier: 0 };
  const agreed: Thread[] = [];
  let moves = 0;
  for (const thread of view.threads.values()) {
    threads.total += 1;
    threads[thread.state] += 1;
    moves += thread.proposals.length;
    if (thread.state === "open" && thread.turn) {
      waitingOn[thread.turn] += 1;
    }
    if (thread.state === "agreed") {
      agreed.push(thread);
    }
  }
  let openDemandValueEur = 0;
  for (const demand of view.demands.values()) {
    if (demand.state === "open") {
      openDemandValueEur += demand.valueEur ?? 0;
    }
  }
  return {
    demands: countPostings(view.demands.values()),
    offers: countPostings(view.offers.values()),
    threads,
    waitingOn,
    moves,
    openDemandValueEur,
    deals: dealStats(view, agreed),
  };
};

const SECOND_MS = 1000;
const MINUTE_MS = 60_000;

export const ACTIVITY_RANGE_KEYS = ["5m", "15m", "30m", "60m"] as const;
export type ActivityRange = (typeof ACTIVITY_RANGE_KEYS)[number];
export const DEFAULT_ACTIVITY_RANGE: ActivityRange = "5m";

// Each range keeps 30 bars, so bucket width grows with the window.
export const ACTIVITY_RANGES: Record<
  ActivityRange,
  { windowMs: number; bucketMs: number }
> = {
  "5m": { windowMs: 5 * MINUTE_MS, bucketMs: 10 * SECOND_MS },
  "15m": { windowMs: 15 * MINUTE_MS, bucketMs: 30 * SECOND_MS },
  "30m": { windowMs: 30 * MINUTE_MS, bucketMs: MINUTE_MS },
  "60m": { windowMs: 60 * MINUTE_MS, bucketMs: 2 * MINUTE_MS },
};

export const parseActivityRange = (value: unknown) =>
  ACTIVITY_RANGE_KEYS.find((range) => range === value);

// "10 seconds", "minute", "2 minutes": reads after "per".
export const formatBucketWidth = (bucketMs: number) => {
  if (bucketMs < MINUTE_MS) {
    return `${bucketMs / SECOND_MS} seconds`;
  }
  const minutes = bucketMs / MINUTE_MS;
  return minutes === 1 ? "minute" : `${minutes} minutes`;
};

export interface ActivityBucket {
  start: number;
  count: number;
}

// Events stamped after `from` (the log is in id order, so walk back).
export const countSince = (events: readonly MarketEvent[], from: number) => {
  let count = 0;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (Date.parse(events[index]?.ts ?? "") <= from) {
      break;
    }
    count += 1;
  }
  return count;
};

// Events per fixed-width bucket over the window ending at `end` (oldest first).
export const activityBuckets = (
  events: readonly MarketEvent[],
  end: number,
  bucketMs: number,
  buckets: number
): ActivityBucket[] => {
  const start = end - bucketMs * buckets;
  const counts = Array.from({ length: buckets }, (_, index) => ({
    start: start + bucketMs * index,
    count: 0,
  }));
  // The log is in id order, so walk back from the newest event.
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const at = Date.parse(events[index]?.ts ?? "");
    if (at < start) {
      break;
    }
    const bucket = counts[Math.floor((at - start) / bucketMs)];
    if (bucket) {
      bucket.count += 1;
    }
  }
  return counts;
};

const PERCENT = new Intl.NumberFormat("en-GB", {
  style: "percent",
  maximumFractionDigits: 1,
  signDisplay: "exceptZero",
});
export const formatSignedPercent = (value: number | null) =>
  value === null ? "—" : PERCENT.format(value);

const MINUTE_S = 60;
const HOUR_S = 3600;

export const formatDuration = (ms: number | null) => {
  if (ms === null) {
    return "—";
  }
  const seconds = Math.max(0, Math.round(ms / SECOND_MS));
  if (seconds < MINUTE_S) {
    return `${seconds}s`;
  }
  if (seconds < HOUR_S) {
    return `${Math.floor(seconds / MINUTE_S)}m ${seconds % MINUTE_S}s`;
  }
  return `${Math.floor(seconds / HOUR_S)}h ${Math.floor((seconds % HOUR_S) / MINUTE_S)}m`;
};
