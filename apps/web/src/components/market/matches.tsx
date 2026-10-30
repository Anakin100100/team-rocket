// The matches tab: open threads first, each as its match row with the price
// chart under it, then the closed ones as rows. Any match opens its full
// thread (every move, message and citation) in a dialog that stays live.
import { Card } from "@rocket/ui/components/card";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@rocket/ui/components/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@rocket/ui/components/tooltip";
import { useState } from "react";
import type { ReactNode } from "react";

import { Empty } from "./postings";
import { PriceChart } from "./price-chart";
import { formatEur } from "./state";
import type { Demand, MarketView, Thread } from "./state";
import { ThreadStateBadge } from "./thread-state-badge";
import { ThreadView } from "./thread-view";

const latestPrice = (thread: Thread) =>
  thread.agreed?.priceEur ?? thread.proposals.at(-1)?.priceEur ?? null;

const openedAt = (thread: Thread) =>
  thread.proposals[0]?.at ?? thread.updatedAt;

const SectionTitle = ({ title, count }: { title: string; count: number }) => (
  <h2 className="text-muted-foreground flex items-baseline gap-2 text-xs font-medium tracking-wide uppercase">
    {title} <span className="tabular-nums">{count}</span>
  </h2>
);

// The match's own data: who, for which demand, and where the price stands.
const MatchRow = ({
  thread,
  demand,
  className,
  onSelect,
}: {
  thread: Thread;
  demand: Demand | undefined;
  className: string;
  onSelect: () => void;
}) => (
  <button
    type="button"
    onClick={onSelect}
    className={`hover:bg-muted flex w-full flex-col gap-1 p-2 text-left text-sm transition-colors ${className}`}
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
    <p className="text-muted-foreground truncate text-xs">
      {demand?.titleEn ?? demand?.title ?? "Demand"} ·{" "}
      {demand?.buyerName ?? "Buyer"}
    </p>
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

const ThreadDialog = ({
  thread,
  demand,
  onClose,
}: {
  thread: Thread | undefined;
  demand: Demand | undefined;
  onClose: () => void;
}) => (
  <Dialog
    open={thread !== undefined}
    onOpenChange={(open) => {
      if (!open) {
        onClose();
      }
    }}
  >
    <DialogContent className="max-h-[90svh] overflow-y-auto p-0 sm:max-w-6xl">
      {thread && (
        <>
          <DialogTitle className="sr-only">
            Negotiation with {thread.supplierName}
          </DialogTitle>
          <ThreadView thread={thread} demand={demand} className="ring-0" />
        </>
      )}
    </DialogContent>
  </Dialog>
);

const Section = ({ children }: { children: ReactNode }) => (
  <section className="flex flex-col gap-2">{children}</section>
);

export const MatchesTab = ({ view }: { view: MarketView }) => {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const threads = [...view.threads.values()];
  // Newest first by opening time, so live cards only move when one opens.
  const live = threads
    .filter((thread) => thread.state === "open")
    .toSorted((a, b) => openedAt(b).localeCompare(openedAt(a)));
  const closed = threads
    .filter((thread) => thread.state !== "open")
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const demandOf = (thread: Thread | undefined) =>
    thread?.demandId ? view.demands.get(thread.demandId) : undefined;
  const selected = selectedId ? view.threads.get(selectedId) : undefined;

  return (
    <div className="flex flex-col gap-6">
      <Section>
        <SectionTitle title="Live negotiations" count={live.length} />
        {live.length === 0 ? (
          <Empty>
            No negotiation is running. Threads open when a demand and an offer
            match on CPV.
          </Empty>
        ) : (
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            {live.map((thread) => (
              <Card key={thread.id} size="sm" className="gap-2 py-0 pb-3">
                <MatchRow
                  thread={thread}
                  demand={demandOf(thread)}
                  className="border-b px-3"
                  onSelect={() => setSelectedId(thread.id)}
                />
                <div className="px-3">
                  <PriceChart thread={thread} />
                </div>
              </Card>
            ))}
          </div>
        )}
      </Section>

      <Section>
        <SectionTitle title="Closed matches" count={closed.length} />
        {closed.length === 0 ? (
          <Empty>Agreed, abandoned and superseded threads land here.</Empty>
        ) : (
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
            {closed.map((thread) => (
              <MatchRow
                key={thread.id}
                thread={thread}
                demand={demandOf(thread)}
                className="rounded-md border"
                onSelect={() => setSelectedId(thread.id)}
              />
            ))}
          </div>
        )}
      </Section>

      <ThreadDialog
        thread={selected}
        demand={demandOf(selected)}
        onClose={() => setSelectedId(null)}
      />
    </div>
  );
};
