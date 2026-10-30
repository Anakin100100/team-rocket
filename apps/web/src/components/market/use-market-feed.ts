// Live event feed for the admin UI (plan.md §6): poll the log by cursor every
// two seconds. Replay re-runs the same log from the first event at speed.
import { useEffect, useMemo, useRef, useState } from "react";

import { client } from "@/utils/orpc";

import { buildView } from "./state";
import type { MarketEvent } from "./state";

const POLL_MS = 2000;
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

export const useMarketFeed = () => {
  const [events, setEvents] = useState<MarketEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  // null = live; a number = how many events the replay currently shows.
  const [replayAt, setReplayAt] = useState<number | null>(null);
  const cursor = useRef(0);
  const polling = useRef(false);

  useEffect(() => {
    const poll = async () => {
      if (polling.current) {
        return;
      }
      polling.current = true;
      try {
        const batch = await fetchSince(cursor.current);
        cursor.current = batch.cursor;
        if (batch.events.length > 0) {
          setEvents((previous) => [...previous, ...batch.events]);
        }
        setError(null);
      } catch (pollError) {
        setError(
          pollError instanceof Error ? pollError.message : "Feed unavailable"
        );
      }
      polling.current = false;
    };
    poll();
    const timer = setInterval(poll, POLL_MS);
    return () => clearInterval(timer);
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
    visibleEvents: visible.length,
    totalEvents: events.length,
    error,
    replaying,
    replay: () => setReplayAt(0),
    stopReplay: () => setReplayAt(null),
  };
};
