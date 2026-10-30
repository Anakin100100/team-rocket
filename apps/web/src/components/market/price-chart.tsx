// Price per move in one thread, with the two sealed limits as dashed lines
// (observer only, plan.md §6). Series colors are --series-buyer and
// --series-supplier (validated categorical slots 1 and 2, light and dark).
import { useId, useState } from "react";

import { formatEur, formatEurShort } from "./state";
import type { Proposal, Side, Thread } from "./state";

const WIDTH = 520;
const HEIGHT = 230;
const MARGIN = { top: 18, right: 112, bottom: 30, left: 64 };
const MIN_MOVES = 4;
const Y_TICKS = 4;
const PAD_BELOW = 0.92;
const PAD_ABOVE = 1.05;
const MARKER_RADIUS = 4;
const HIT_RADIUS = 14;
const AGREED_RING = 9;

const SERIES: Record<Side, { label: string; color: string }> = {
  buyer: { label: "Buyer", color: "var(--series-buyer)" },
  supplier: { label: "Supplier", color: "var(--series-supplier)" },
};

// 1, 2, 2.5 or 5 × a power of ten, so axis labels are round numbers.
const niceStep = (rough: number) => {
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const multiple = [1, 2, 2.5, 5, 10].find((m) => m * magnitude >= rough) ?? 10;
  return multiple * magnitude;
};

const plotWidth = WIDTH - MARGIN.left - MARGIN.right;
const plotHeight = HEIGHT - MARGIN.top - MARGIN.bottom;

const LegendLine = ({ color, dashed }: { color: string; dashed?: boolean }) => (
  <svg width="20" height="8" aria-hidden="true" className="shrink-0">
    <line
      x1="0"
      y1="4"
      x2="20"
      y2="4"
      stroke={color}
      strokeWidth="2"
      strokeDasharray={dashed ? "4 3" : undefined}
      strokeLinecap="round"
    />
  </svg>
);

export const PriceChart = ({ thread }: { thread: Thread }) => {
  const [hovered, setHovered] = useState<Proposal | null>(null);
  const titleId = useId();
  const { proposals } = thread;
  const moves = Math.max(MIN_MOVES, proposals.length);
  const limits = [thread.threadFloorEur, thread.walkAwayEur].filter(
    (value): value is number => value !== null
  );
  const values = [...proposals.map((proposal) => proposal.priceEur), ...limits];
  const step = niceStep(
    (Math.max(...values) * PAD_ABOVE - Math.min(...values) * PAD_BELOW) /
      Y_TICKS
  );
  const low = Math.floor((Math.min(...values) * PAD_BELOW) / step) * step;
  const high = Math.ceil((Math.max(...values) * PAD_ABOVE) / step) * step;
  const x = (move: number) =>
    MARGIN.left + ((move - 1) / Math.max(1, moves - 1)) * plotWidth;
  const y = (price: number) =>
    MARGIN.top + (1 - (price - low) / Math.max(1, high - low)) * plotHeight;
  const ticks = Array.from(
    { length: Math.round((high - low) / step) + 1 },
    (_, index) => low + step * index
  );

  // The proposal the agreement signed: the last one before the accept.
  const accepted = thread.agreed ? proposals.at(-1) : undefined;
  const bySide = (side: Side) =>
    proposals.filter((proposal) => proposal.by === side);

  return (
    <figure className="flex w-full max-w-2xl flex-col gap-2">
      <figcaption className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        <span className="flex items-center gap-1.5">
          <LegendLine color={SERIES.buyer.color} /> Buyer proposals
        </span>
        <span className="flex items-center gap-1.5">
          <LegendLine color={SERIES.supplier.color} /> Supplier proposals
        </span>
        <span className="flex items-center gap-1.5">
          <LegendLine color="var(--muted-foreground)" dashed /> Sealed limits
          (observer only)
        </span>
      </figcaption>
      <div className="relative">
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          className="h-auto w-full"
          aria-labelledby={titleId}
        >
          <title id={titleId}>
            {`Price per move for ${thread.supplierName}: ${proposals
              .map(
                (proposal) => `${proposal.by} ${formatEur(proposal.priceEur)}`
              )
              .join(", ")}`}
          </title>
          {ticks.map((tick) => (
            <g key={tick}>
              <line
                x1={MARGIN.left}
                x2={WIDTH - MARGIN.right}
                y1={y(tick)}
                y2={y(tick)}
                stroke="var(--border)"
                strokeWidth="1"
              />
              <text
                x={MARGIN.left - 8}
                y={y(tick)}
                textAnchor="end"
                dominantBaseline="middle"
                className="fill-muted-foreground text-[11px]"
              >
                {formatEurShort(tick)}
              </text>
            </g>
          ))}
          {Array.from({ length: moves }, (_, index) => index + 1).map(
            (move) => (
              <text
                key={move}
                x={x(move)}
                y={HEIGHT - 8}
                textAnchor="middle"
                className="fill-muted-foreground text-[11px]"
              >
                {move}
              </text>
            )
          )}

          {[
            { value: thread.walkAwayEur, label: "walk-away" },
            { value: thread.threadFloorEur, label: "floor" },
          ].map(({ value, label }) =>
            value === null ? null : (
              <g key={label}>
                <line
                  x1={MARGIN.left}
                  x2={WIDTH - MARGIN.right}
                  y1={y(value)}
                  y2={y(value)}
                  stroke="var(--muted-foreground)"
                  strokeWidth="1.5"
                  strokeDasharray="5 4"
                />
                <text
                  x={WIDTH - MARGIN.right + 6}
                  y={y(value)}
                  dominantBaseline="middle"
                  className="fill-muted-foreground text-[11px]"
                >
                  {label} {formatEurShort(value)}
                </text>
              </g>
            )
          )}

          {(["supplier", "buyer"] as const).map((side) => {
            const points = bySide(side);
            const last = points.at(-1);
            return (
              <g key={side}>
                {points.length > 1 && (
                  <polyline
                    points={points
                      .map((point) => `${x(point.move)},${y(point.priceEur)}`)
                      .join(" ")}
                    fill="none"
                    stroke={SERIES[side].color}
                    strokeWidth="2"
                    strokeLinejoin="round"
                    strokeLinecap="round"
                  />
                )}
                {points.map((point) => (
                  <circle
                    key={point.move}
                    cx={x(point.move)}
                    cy={y(point.priceEur)}
                    r={MARKER_RADIUS}
                    fill={SERIES[side].color}
                    stroke="var(--card)"
                    strokeWidth="2"
                  />
                ))}
                {last && last !== accepted && (
                  <text
                    x={x(last.move) + 10}
                    y={y(last.priceEur) + (side === "buyer" ? 14 : -10)}
                    className="fill-foreground text-[11px] font-medium"
                  >
                    {SERIES[side].label} {formatEurShort(last.priceEur)}
                  </text>
                )}
              </g>
            );
          })}

          {accepted && (
            <g>
              <circle
                cx={x(accepted.move)}
                cy={y(accepted.priceEur)}
                r={AGREED_RING}
                fill="none"
                stroke="var(--foreground)"
                strokeWidth="2"
              />
              <text
                x={x(accepted.move) - AGREED_RING - 6}
                y={y(accepted.priceEur)}
                textAnchor="end"
                dominantBaseline="middle"
                className="fill-foreground text-[11px] font-semibold"
              >
                agreed {formatEurShort(accepted.priceEur)}
              </text>
            </g>
          )}

          {proposals.map((proposal) => (
            <circle
              key={proposal.move}
              cx={x(proposal.move)}
              cy={y(proposal.priceEur)}
              r={HIT_RADIUS}
              fill="transparent"
              onMouseEnter={() => setHovered(proposal)}
              onMouseLeave={() => setHovered(null)}
            />
          ))}
        </svg>
        {hovered && (
          <div
            className="bg-popover text-popover-foreground pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-md border px-2 py-1 text-xs shadow-md"
            style={{
              left: `${(x(hovered.move) / WIDTH) * 100}%`,
              top: `calc(${(y(hovered.priceEur) / HEIGHT) * 100}% - 10px)`,
            }}
          >
            <div className="font-medium">
              Move {hovered.move} · {SERIES[hovered.by].label}
            </div>
            <div>
              {formatEur(hovered.priceEur)} · {hovered.leadTimeDays} days
            </div>
          </div>
        )}
      </div>
    </figure>
  );
};
