// One negotiation thread: the chart, then every move with its message and
// the TED notices it cites (plan.md §6).
import { Badge } from "@rocket/ui/components/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@rocket/ui/components/card";

import { PriceChart } from "./price-chart";
import { formatEur, formatTime } from "./state";
import type { Demand, Side, Thread } from "./state";
import { ThreadStateBadge } from "./thread-state-badge";

const TED_NOTICE = /detail\/(?<notice>[^/?#]+)/u;

const SIDE_DOT: Record<Side, string> = {
  buyer: "bg-[var(--series-buyer)]",
  supplier: "bg-[var(--series-supplier)]",
};

const citeLabel = (url: string) =>
  TED_NOTICE.exec(url)?.groups?.notice ?? "source";

export const ThreadView = ({
  thread,
  demand,
}: {
  thread: Thread;
  demand: Demand | undefined;
}) => {
  const buyerName = demand?.buyerName ?? "Buyer";
  const sideName = (side: Side) =>
    side === "buyer" ? buyerName : thread.supplierName;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <span>
            {demand?.titleEn ?? demand?.title ?? "Demand"} ×{" "}
            {thread.supplierName}
          </span>
          <ThreadStateBadge state={thread.state} />
          <Badge variant="outline">Tier {thread.tier}</Badge>
        </CardTitle>
        <CardDescription>
          {buyerName}
          {demand?.buyerCountry ? ` (${demand.buyerCountry})` : ""} negotiating
          with {thread.supplierName} ({thread.supplierCountry}) ·{" "}
          {thread.winsInCpv} public wins in the matched CPV
        </CardDescription>
      </CardHeader>
      <CardContent className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <PriceChart thread={thread} />
        <ol className="flex flex-col divide-y">
          {thread.proposals.map((proposal) => (
            <li
              key={proposal.move}
              className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 py-2 text-sm"
            >
              <span className="text-muted-foreground tabular-nums">
                {formatTime(proposal.at)}
              </span>
              <div className="flex flex-wrap items-center gap-x-2">
                <span
                  className={`size-2 rounded-full ${SIDE_DOT[proposal.by]}`}
                  aria-hidden="true"
                />
                <span className="font-medium">{sideName(proposal.by)}</span>
                <span className="font-semibold tabular-nums">
                  {formatEur(proposal.priceEur)}
                </span>
                <span className="text-muted-foreground">
                  {proposal.leadTimeDays} days · move {proposal.move}
                </span>
              </div>
              <span />
              <div className="flex flex-col gap-1">
                <p className="text-pretty">{proposal.message}</p>
                {proposal.cites.length > 0 && (
                  <div className="flex flex-wrap gap-2 text-xs">
                    {proposal.cites.map((url) => (
                      <a
                        key={url}
                        href={url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary underline-offset-2 hover:underline"
                      >
                        TED {citeLabel(url)} ↗
                      </a>
                    ))}
                  </div>
                )}
              </div>
            </li>
          ))}
          {thread.agreed && (
            <li className="grid grid-cols-[auto_1fr] gap-x-3 py-2 text-sm">
              <span className="text-muted-foreground tabular-nums">
                {formatTime(thread.agreed.at)}
              </span>
              <p className="font-semibold">
                {sideName(thread.agreed.by)} accepted:{" "}
                {formatEur(thread.agreed.priceEur)},{" "}
                {thread.agreed.leadTimeDays} days. Deal.
              </p>
            </li>
          )}
          {thread.closedReason && (
            <li className="text-muted-foreground py-2 text-sm">
              {thread.closedBy
                ? `${sideName(thread.closedBy)} walked away: `
                : ""}
              {thread.closedReason}
            </li>
          )}
        </ol>
      </CardContent>
    </Card>
  );
};
