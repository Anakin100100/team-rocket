// Admin UI for the agent marketplace (plan.md §6): read only, rebuilt from the
// event log, polled every two seconds. No forms: the agents are already
// trading. Sealed limits show here because this is the observer's view.
import { Badge } from "@rocket/ui/components/badge";
import { Button } from "@rocket/ui/components/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@rocket/ui/components/card";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@rocket/ui/components/tooltip";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import type { ReactNode } from "react";

import { formatDateTime, formatEur } from "@/components/market/state";
import type {
  Demand,
  MarketView,
  Offer,
  Thread,
} from "@/components/market/state";
import { ThreadStateBadge } from "@/components/market/thread-state-badge";
import { ThreadView } from "@/components/market/thread-view";
import { useMarketFeed } from "@/components/market/use-market-feed";
import { orpc } from "@/utils/orpc";

const AGENTS_POLL_MS = 5000;

const Column = ({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: ReactNode;
}) => (
  <section className="flex min-w-0 flex-col gap-2">
    <h2 className="text-muted-foreground flex items-baseline gap-2 text-xs font-medium tracking-wide uppercase">
      {title} <span className="tabular-nums">{count}</span>
    </h2>
    {children}
  </section>
);

const Empty = ({ children }: { children: ReactNode }) => (
  <p className="text-muted-foreground rounded-md border border-dashed p-3 text-sm">
    {children}
  </p>
);

const Sealed = ({ label, value }: { label: string; value: number | null }) =>
  value === null ? null : (
    <p className="text-muted-foreground text-xs">
      {label} {formatEur(value)} <span className="italic">(sealed)</span>
    </p>
  );

const DemandCard = ({ demand }: { demand: Demand }) => (
  <Card size="sm">
    <CardContent className="flex flex-col gap-1 text-sm">
      <div className="flex items-start justify-between gap-2">
        <p className="font-medium">{demand.titleEn ?? demand.title}</p>
        <Badge variant={demand.state === "filled" ? "default" : "outline"}>
          {demand.state}
        </Badge>
      </div>
      {demand.titleEn && (
        <p className="text-muted-foreground text-xs">{demand.title}</p>
      )}
      <p>
        {demand.buyerName ?? "Buyer"}
        {demand.buyerCountry ? ` (${demand.buyerCountry})` : ""}
      </p>
      <p className="text-muted-foreground text-xs">{demand.need}</p>
      <p className="tabular-nums">
        CPV {demand.cpv} · {formatEur(demand.valueEur)}
        {demand.deadline ? ` · deadline ${demand.deadline}` : ""}
      </p>
      <Sealed label="walk-away" value={demand.walkAwayEur} />
      {demand.url && (
        <a
          href={demand.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary text-xs underline-offset-2 hover:underline"
        >
          TED notice {demand.listingId} ↗
        </a>
      )}
    </CardContent>
  </Card>
);

const OfferCard = ({ offer }: { offer: Offer }) => (
  <Card size="sm">
    <CardContent className="flex flex-col gap-1 text-sm">
      <div className="flex items-start justify-between gap-2">
        <p className="font-medium">{offer.supplierName}</p>
        <Badge variant={offer.state === "filled" ? "default" : "outline"}>
          {offer.state}
        </Badge>
      </div>
      <p className="tabular-nums">
        CPV class {offer.cpvClass} · ask {formatEur(offer.askEur)} ·{" "}
        {offer.leadTimeDays} days
      </p>
      <p className="text-muted-foreground text-xs">{offer.note}</p>
      <Sealed label="floor" value={offer.floorEur} />
    </CardContent>
  </Card>
);

const latestPrice = (thread: Thread) =>
  thread.agreed?.priceEur ?? thread.proposals.at(-1)?.priceEur ?? null;

const MatchRow = ({
  thread,
  selected,
  onSelect,
}: {
  thread: Thread;
  selected: boolean;
  onSelect: () => void;
}) => (
  <button
    type="button"
    onClick={onSelect}
    aria-pressed={selected}
    className={`hover:bg-muted flex w-full flex-col gap-1 rounded-md border p-2 text-left text-sm transition-colors ${selected ? "border-primary bg-muted" : ""}`}
  >
    <div className="flex items-center justify-between gap-2">
      <Tooltip>
        <TooltipTrigger render={<span className="truncate font-medium" />}>
          {thread.supplierName}
        </TooltipTrigger>
        <TooltipContent>
          {thread.supplierCountry} · tier {thread.tier} · {thread.winsInCpv}{" "}
          public wins in the matched CPV
        </TooltipContent>
      </Tooltip>
      <ThreadStateBadge state={thread.state} />
    </div>
    <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 text-xs tabular-nums">
      <span>{thread.supplierCountry}</span>
      <span>T{thread.tier}</span>
      <span>
        {thread.proposals.length} move{thread.proposals.length === 1 ? "" : "s"}
      </span>
      <span className="text-foreground font-medium">
        {formatEur(latestPrice(thread))}
      </span>
      {thread.turn && <span>turn: {thread.turn}</span>}
    </div>
  </button>
);

const pickDefaultThread = (view: MarketView) => {
  const threads = [...view.threads.values()];
  return (
    threads.find((thread) => thread.state === "agreed") ??
    threads.toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
  );
};

const MarketPage = () => {
  const feed = useMarketFeed();
  const { replay: handleReplay, stopReplay: handleStopReplay } = feed;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const agents = useQuery({
    ...orpc.market.agents.queryOptions(),
    refetchInterval: AGENTS_POLL_MS,
  });

  const { view } = feed;
  const demands = [...view.demands.values()];
  const offers = [...view.offers.values()];
  const threads = [...view.threads.values()].toSorted((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt)
  );
  const selected =
    (selectedId ? view.threads.get(selectedId) : undefined) ??
    pickDefaultThread(view);
  const fetchedAt = demands.find((demand) => demand.fetchedAt)?.fetchedAt;
  const online = agents.data?.filter((agent) => agent.online) ?? [];

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 p-4 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-medium">Market</h1>
          <p className="text-muted-foreground text-sm">
            Buyer and supplier agents trading on public TED records. Read only.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {fetchedAt && (
            <Badge variant="outline">
              TED fetched {formatDateTime(fetchedAt)}
            </Badge>
          )}
          <Badge variant="outline" className="tabular-nums">
            {feed.replaying
              ? `replay ${feed.visibleEvents}/${feed.totalEvents}`
              : `${feed.totalEvents} events`}
          </Badge>
          <Tooltip>
            <TooltipTrigger render={<span />}>
              <Badge variant={online.length > 0 ? "default" : "outline"}>
                {online.length}/{agents.data?.length ?? 0} agents online
              </Badge>
            </TooltipTrigger>
            <TooltipContent>
              {online.length > 0
                ? online.map((agent) => agent.name).join(", ")
                : "No agent called wait in the last 30 seconds."}
            </TooltipContent>
          </Tooltip>
          {feed.replaying ? (
            <Button size="sm" variant="outline" onClick={handleStopReplay}>
              Stop replay
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              onClick={handleReplay}
              disabled={feed.totalEvents === 0}
            >
              Replay
            </Button>
          )}
        </div>
      </div>

      {feed.error && (
        <p className="text-destructive text-sm">
          Feed unavailable: {feed.error}
        </p>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-[1fr_1.2fr_1fr]">
        <Column title="Demands" count={demands.length}>
          {demands.length === 0 ? (
            <Empty>No demand posted yet. Start the buyer agent.</Empty>
          ) : (
            demands.map((demand) => (
              <DemandCard key={demand.id} demand={demand} />
            ))
          )}
        </Column>
        <Column title="Matches" count={threads.length}>
          {threads.length === 0 ? (
            <Empty>Threads open when a demand and an offer match on CPV.</Empty>
          ) : (
            threads.map((thread) => (
              <MatchRow
                key={thread.id}
                thread={thread}
                selected={thread.id === selected?.id}
                onSelect={() => setSelectedId(thread.id)}
              />
            ))
          )}
        </Column>
        <Column title="Offers" count={offers.length}>
          {offers.length === 0 ? (
            <Empty>No offer posted yet. Start the supplier agents.</Empty>
          ) : (
            offers.map((offer) => <OfferCard key={offer.id} offer={offer} />)
          )}
        </Column>
      </div>

      {selected ? (
        <ThreadView
          thread={selected}
          demand={
            selected.demandId ? view.demands.get(selected.demandId) : undefined
          }
        />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Thread</CardTitle>
          </CardHeader>
          <CardContent>
            <Empty>Click a match to follow its negotiation.</Empty>
          </CardContent>
        </Card>
      )}
    </div>
  );
};

export const Route = createFileRoute("/market")({
  component: MarketPage,
});
