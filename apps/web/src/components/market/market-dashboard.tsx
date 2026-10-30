// The dashboard tab: aggregates only, no individual postings or threads.
// Re-renders every second so "ago" values and the activity window keep moving
// between events. Time runs on the server's clock (event times are the
// server's), and during a replay it is the last replayed event.
import { Button } from "@rocket/ui/components/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@rocket/ui/components/card";
import { useEffect, useId, useState } from "react";
import type { ReactNode } from "react";

import type { client } from "@/utils/orpc";

import { formatEur, formatEurShort, formatTime } from "./state";
import type { MarketEvent, MarketView } from "./state";
import {
  ACTIVITY_RANGE_KEYS,
  ACTIVITY_RANGES,
  activityBuckets,
  computeStats,
  countSince,
  formatBucketWidth,
  formatDuration,
  formatSignedPercent,
} from "./stats";
import type { ActivityBucket, ActivityRange } from "./stats";

export type MarketAgent = Awaited<
  ReturnType<typeof client.market.agents>
>[number];

const CLOCK_MS = 1000;
const MINUTE_MS = 60_000;
const CHART_WIDTH = 640;
const CHART_HEIGHT = 160;
const CHART_MARGIN = { top: 12, right: 8, bottom: 22, left: 32 };
const BAR_GAP = 2;
const BAR_RADIUS = 4;
// Single series: the theme's second chart step (passes 3:1 on both cards).
const BAR_COLOR = "var(--chart-2)";

const useNow = (intervalMs: number) => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
};

const plural = (count: number, noun: string) =>
  `${count} ${noun}${count === 1 ? "" : "s"}`;

const StatTile = ({
  label,
  value,
  detail,
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
}) => (
  <Card size="sm">
    <CardContent className="flex flex-col gap-1">
      <p className="text-muted-foreground text-xs">{label}</p>
      <p className="text-2xl font-semibold">{value}</p>
      {detail && <p className="text-muted-foreground text-xs">{detail}</p>}
    </CardContent>
  </Card>
);

// Rounded at the data end, square on the baseline.
const barPath = (x: number, y: number, width: number, base: number) => {
  const radius = Math.min(BAR_RADIUS, width / 2, base - y);
  return `M${x},${base} V${y + radius} Q${x},${y} ${x + radius},${y} H${x + width - radius} Q${x + width},${y} ${x + width},${y + radius} V${base} Z`;
};

const ActivityChart = ({
  buckets,
  bucketMs,
  windowMinutes,
}: {
  buckets: ActivityBucket[];
  bucketMs: number;
  windowMinutes: number;
}) => {
  // Keyed by bucket start: the buckets are rebuilt every second.
  const [hoveredStart, setHoveredStart] = useState<number | null>(null);
  const titleId = useId();
  const peak = Math.max(1, ...buckets.map((bucket) => bucket.count));
  const plotWidth = CHART_WIDTH - CHART_MARGIN.left - CHART_MARGIN.right;
  const base = CHART_HEIGHT - CHART_MARGIN.bottom;
  const plotHeight = base - CHART_MARGIN.top;
  const slot = plotWidth / buckets.length;
  const x = (index: number) => CHART_MARGIN.left + slot * index;
  const y = (count: number) => base - (count / peak) * plotHeight;
  const total = buckets.reduce((sum, bucket) => sum + bucket.count, 0);
  const hoveredIndex = buckets.findIndex(
    (bucket) => bucket.start === hoveredStart
  );
  const hovered = buckets[hoveredIndex];

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
        className="h-auto w-full"
        aria-labelledby={titleId}
      >
        <title id={titleId}>
          {`${plural(total, "event")} in the last ${windowMinutes} minutes, at most ${peak} per ${formatBucketWidth(bucketMs)}`}
        </title>
        {[0, peak].map((tick) => (
          <g key={tick}>
            <line
              x1={CHART_MARGIN.left}
              x2={CHART_WIDTH - CHART_MARGIN.right}
              y1={y(tick)}
              y2={y(tick)}
              stroke="var(--border)"
              strokeWidth="1"
            />
            <text
              x={CHART_MARGIN.left - 6}
              y={y(tick)}
              textAnchor="end"
              dominantBaseline="middle"
              className="fill-muted-foreground text-[11px] tabular-nums"
            >
              {tick}
            </text>
          </g>
        ))}
        {buckets.map((bucket, index) =>
          bucket.count === 0 ? null : (
            <path
              key={bucket.start}
              d={barPath(
                x(index) + BAR_GAP / 2,
                y(bucket.count),
                slot - BAR_GAP,
                base
              )}
              fill={BAR_COLOR}
              opacity={hoveredIndex === -1 || hoveredIndex === index ? 1 : 0.5}
            />
          )
        )}
        <text
          x={CHART_MARGIN.left}
          y={CHART_HEIGHT - 4}
          className="fill-muted-foreground text-[11px]"
        >
          {windowMinutes} min ago
        </text>
        <text
          x={CHART_WIDTH - CHART_MARGIN.right}
          y={CHART_HEIGHT - 4}
          textAnchor="end"
          className="fill-muted-foreground text-[11px]"
        >
          now
        </text>
        {buckets.map((bucket, index) => (
          <rect
            key={bucket.start}
            x={x(index)}
            y={CHART_MARGIN.top}
            width={slot}
            height={plotHeight}
            fill="transparent"
            onMouseEnter={() => setHoveredStart(bucket.start)}
            onMouseLeave={() => setHoveredStart(null)}
          />
        ))}
      </svg>
      {hovered && (
        <div
          className="bg-popover text-popover-foreground pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-md border px-2 py-1 text-xs shadow-md"
          style={{
            left: `${((x(hoveredIndex) + slot / 2) / CHART_WIDTH) * 100}%`,
            top: `calc(${(y(hovered.count) / CHART_HEIGHT) * 100}% - 6px)`,
          }}
        >
          <div className="font-medium">{plural(hovered.count, "event")}</div>
          <div className="text-muted-foreground">
            {formatTime(new Date(hovered.start).toISOString())} –{" "}
            {formatTime(new Date(hovered.start + bucketMs).toISOString())}
          </div>
        </div>
      )}
    </div>
  );
};

const onlineByKind = (agents: MarketAgent[]) => {
  const counts = new Map<string, number>();
  for (const agent of agents) {
    if (agent.online) {
      counts.set(agent.kind, (counts.get(agent.kind) ?? 0) + 1);
    }
  }
  return [...counts].map(([kind, count]) => plural(count, kind)).join(" · ");
};

const RangePicker = ({
  range,
  onChange,
}: {
  range: ActivityRange;
  onChange: (range: ActivityRange) => void;
}) => (
  <fieldset className="flex gap-1">
    <legend className="sr-only">Activity time range</legend>
    {ACTIVITY_RANGE_KEYS.map((key) => (
      <Button
        key={key}
        size="xs"
        variant={key === range ? "secondary" : "ghost"}
        aria-pressed={key === range}
        onClick={() => onChange(key)}
      >
        {key}
      </Button>
    ))}
  </fieldset>
);

export const MarketDashboard = ({
  view,
  events,
  agents,
  replaying,
  serverLeadMs,
  range,
  onRangeChange,
}: {
  view: MarketView;
  events: readonly MarketEvent[];
  agents: MarketAgent[] | undefined;
  replaying: boolean;
  serverLeadMs: number;
  range: ActivityRange;
  onRangeChange: (range: ActivityRange) => void;
}) => {
  const now = useNow(CLOCK_MS);
  const lastEvent = events.at(-1);
  const clock =
    replaying && lastEvent ? Date.parse(lastEvent.ts) : now + serverLeadMs;
  const stats = computeStats(view);
  const { windowMs, bucketMs } = ACTIVITY_RANGES[range];
  // Aligned to whole buckets so bars hold still between ticks; the last one
  // is the bucket in progress.
  const buckets = activityBuckets(
    events,
    Math.ceil(clock / bucketMs) * bucketMs,
    bucketMs,
    windowMs / bucketMs
  );
  const lastMinute = countSince(events, clock - MINUTE_MS);
  const online = agents?.filter((agent) => agent.online) ?? [];
  const { deals, demands, offers, threads, waitingOn } = stats;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <Card>
          <CardHeader>
            <CardTitle>Agreed deal value</CardTitle>
            <CardDescription>
              {plural(deals.count, "deal")} closed agent to agent
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <p className="text-5xl font-semibold">
              {formatEurShort(deals.valueEur)}
            </p>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-muted-foreground">vs published value</dt>
              <dd className="tabular-nums">
                {formatSignedPercent(deals.vsPublished)}
              </dd>
              <dt className="text-muted-foreground">vs opening ask</dt>
              <dd className="tabular-nums">
                {formatSignedPercent(deals.vsOpeningAsk)}
              </dd>
              <dt className="text-muted-foreground">Avg moves per deal</dt>
              <dd className="tabular-nums">
                {deals.avgMoves === null ? "—" : deals.avgMoves.toFixed(1)}
              </dd>
              <dt className="text-muted-foreground">Avg time to deal</dt>
              <dd className="tabular-nums">
                {formatDuration(deals.avgDurationMs)}
              </dd>
            </dl>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Market activity</CardTitle>
            <CardDescription>
              Events per {formatBucketWidth(bucketMs)} · {lastMinute} in the
              last minute
            </CardDescription>
            <CardAction>
              <RangePicker range={range} onChange={onRangeChange} />
            </CardAction>
          </CardHeader>
          <CardContent>
            <ActivityChart
              buckets={buckets}
              bucketMs={bucketMs}
              windowMinutes={windowMs / MINUTE_MS}
            />
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile
          label="Agents online"
          value={`${online.length} / ${agents?.length ?? 0}`}
          detail={
            online.length > 0 ? onlineByKind(online) : "None in the last 30s"
          }
        />
        <StatTile
          label="Live negotiations"
          value={threads.open}
          detail={`${waitingOn.buyer} on buyers · ${waitingOn.supplier} on suppliers`}
        />
        <StatTile
          label="Matches opened"
          value={threads.total}
          detail={`${threads.agreed} agreed · ${threads.abandoned} abandoned · ${threads.superseded} superseded`}
        />
        <StatTile
          label="Moves made"
          value={stats.moves}
          detail="Opening asks and counter-proposals"
        />
        <StatTile
          label="Open demands"
          value={demands.open}
          detail={`of ${demands.total} · ${demands.filled} filled · ${demands.withdrawn} withdrawn`}
        />
        <StatTile
          label="Open offers"
          value={offers.open}
          detail={`of ${offers.total} · ${offers.filled} filled · ${offers.withdrawn} withdrawn`}
        />
        <StatTile
          label="Open demand value"
          value={formatEurShort(stats.openDemandValueEur)}
          detail={`${formatEur(stats.openDemandValueEur)} published`}
        />
        <StatTile
          label="Last event"
          value={
            lastEvent
              ? `${formatDuration(clock - Date.parse(lastEvent.ts))} ago`
              : "—"
          }
          detail={
            lastEvent
              ? lastEvent.action.replaceAll("_", " ")
              : "Waiting for the first event"
          }
        />
      </div>
    </div>
  );
};
