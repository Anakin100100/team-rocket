// Live event feed for the admin UI (plan.md §6): poll the log by cursor every
// quarter second, so nothing on screen is more than a second behind the
// server. Replay re-runs the same log from the first event at speed.
import { useEffect, useMemo, useRef, useState } from "react";

import { client } from "@/utils/orpc";

import { buildView } from "./state";
import type { MarketEvent } from "./state";

const POLL_MS = 250;
const PAGE_SIZE = 500;
const REPLAY_STEP_MS = 350;

// Every event after the cursor, page by page (each page starts where the
// previous one ended, so they are fetched in order).
const fetchSince = async (since: number) => {
  const collected: MarketEvent[] = [];
  let cursor = since;
  let more = true;
  while (more) {
    // oxlint-disable-next-line no-await-in-loop
    const page = await client.market.events({
      since: cursor,
      limit: PAGE_SIZE,
    });
    collected.push(...page.events);
    ({ cursor } = page);
    more = page.events.length === PAGE_SIZE;
  }
  return { events: collected, cursor };
};

// The largest `ts - arrival` over the batch: an event cannot be stamped later
// than the server's own time when it arrives, so each is a lower bound on how
// far the server's clock runs ahead of this browser's.
const leadOf = (
  events: readonly MarketEvent[],
  arrivedAt: number,
  floor: number
) => {
  let lead = floor;
  for (const event of events) {
    const stamped = Date.parse(event.ts);
    if (!Number.isNaN(stamped)) {
      lead = Math.max(lead, stamped - arrivedAt);
    }
  }
  return lead;
};

export const useMarketFeed = () => {
  const [events, setEvents] = useState<MarketEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  // null = live; a number = how many events the replay currently shows.
  const [replayAt, setReplayAt] = useState<number | null>(null);
  // Server clock minus browser clock (negative: the server is behind). Event
  // times come from the server, so "now" on screen is Date.now() + this.
  const [serverLeadMs, setServerLeadMs] = useState(0);
  const cursor = useRef(0);
  const lead = useRef(Number.NEGATIVE_INFINITY);
  const loaded = useRef(false);
  const sawLive = useRef(false);

  // Each poll schedules the next once it lands, so a slow response delays
  // the following one instead of skipping a tick. A stopped loop drops its
  // in-flight answer, so a remount never appends the same events twice.
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const batch = await fetchSince(cursor.current);
        if (stopped) {
          return;
        }
        cursor.current = batch.cursor;
        lead.current = leadOf(batch.events, Date.now(), lead.current);
        // The first load is history of unknown age: until an event arrives
        // live, it can only show that the server runs ahead.
        if (loaded.current && batch.events.length > 0) {
          sawLive.current = true;
        }
        loaded.current = true;
        const known = Number.isFinite(lead.current) ? lead.current : 0;
        setServerLeadMs(sawLive.current ? known : Math.max(0, known));
        if (batch.events.length > 0) {
          setEvents((previous) => [...previous, ...batch.events]);
        }
        setError(null);
      } catch (pollError) {
        if (stopped) {
          return;
        }
        setError(
          pollError instanceof Error ? pollError.message : "Feed unavailable"
        );
      }
      timer = setTimeout(poll, POLL_MS);
    };
    poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, []);

  // The replay is over once it has caught up with the live log.
  const replaying = replayAt !== null && replayAt < events.length;

  useEffect(() => {
    if (replayAt === null || replayAt >= events.length) {
      return;
    }
    const timer = setTimeout(() => setReplayAt(replayAt + 1), REPLAY_STEP_MS);
    return () => clearTimeout(timer);
  }, [replayAt, events.length]);

  const visible = useMemo(
    () => (replaying ? events.slice(0, replayAt ?? 0) : events),
    [events, replaying, replayAt]
  );
  const view = useMemo(() => buildView(visible), [visible]);

  return {
    view,
    events: visible,
    serverLeadMs,
    visibleEvents: visible.length,
    totalEvents: events.length,
    error,
    replaying,
    replay: () => setReplayAt(0),
    stopReplay: () => setReplayAt(null),
  };
};
