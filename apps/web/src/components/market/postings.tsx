// The demands and offers tabs: every posting as a card, newest first, with
// how its matches stand. Sealed limits show because this is the observer view.
import { Badge } from "@rocket/ui/components/badge";
import { Card, CardContent } from "@rocket/ui/components/card";
import type { ReactNode } from "react";

import { formatEur } from "./state";
import type { Demand, MarketView, Offer, PostingState, Thread } from "./state";

const STATE_VARIANT: Record<PostingState, "default" | "outline" | "secondary"> =
  {
    open: "outline",
    filled: "default",
    withdrawn: "secondary",
  };

interface MatchTally {
  total: number;
  live: number;
  agreedEur: number | null;
}

type PostingKey = "demandId" | "offerId";

const tallyBy = (threads: Iterable<Thread>, key: PostingKey) => {
  const tallies = new Map<string, MatchTally>();
  for (const thread of threads) {
    const id = thread[key];
    if (!id) {
      continue;
    }
    const tally = tallies.get(id) ?? { total: 0, live: 0, agreedEur: null };
    tally.total += 1;
    if (thread.state === "open") {
      tally.live += 1;
    }
    if (thread.agreed) {
      tally.agreedEur = thread.agreed.priceEur;
    }
    tallies.set(id, tally);
  }
  return tallies;
};

export const Empty = ({ children }: { children: ReactNode }) => (
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

const Tally = ({ tally }: { tally: MatchTally | undefined }) => {
  if (!tally) {
    return <p className="text-muted-foreground text-xs">No matches yet</p>;
  }
  return (
    <p className="text-muted-foreground text-xs tabular-nums">
      {tally.total} match{tally.total === 1 ? "" : "es"} · {tally.live} live
      {tally.agreedEur === null
        ? ""
        : ` · deal at ${formatEur(tally.agreedEur)}`}
    </p>
  );
};

const DemandCard = ({
  demand,
  tally,
}: {
  demand: Demand;
  tally: MatchTally | undefined;
}) => (
  <Card size="sm">
    <CardContent className="flex flex-col gap-1 text-sm">
      <div className="flex items-start justify-between gap-2">
        <p className="font-medium">{demand.titleEn ?? demand.title}</p>
        <Badge variant={STATE_VARIANT[demand.state]}>{demand.state}</Badge>
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
      <Tally tally={tally} />
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

const OfferCard = ({
  offer,
  tally,
}: {
  offer: Offer;
  tally: MatchTally | undefined;
}) => (
  <Card size="sm">
    <CardContent className="flex flex-col gap-1 text-sm">
      <div className="flex items-start justify-between gap-2">
        <p className="font-medium">{offer.supplierName}</p>
        <Badge variant={STATE_VARIANT[offer.state]}>{offer.state}</Badge>
      </div>
      <p className="tabular-nums">
        CPV class {offer.cpvClass} · ask {formatEur(offer.askEur)} ·{" "}
        {offer.leadTimeDays} days
      </p>
      <p className="text-muted-foreground text-xs">{offer.note}</p>
      <Sealed label="floor" value={offer.floorEur} />
      <Tally tally={tally} />
    </CardContent>
  </Card>
);

const POSTING_GRID = "grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3";

export const DemandsTab = ({ view }: { view: MarketView }) => {
  const demands = [...view.demands.values()].toReversed();
  if (demands.length === 0) {
    return <Empty>No demand posted yet. Start the buyer agent.</Empty>;
  }
  const tallies = tallyBy(view.threads.values(), "demandId");
  return (
    <div className={POSTING_GRID}>
      {demands.map((demand) => (
        <DemandCard
          key={demand.id}
          demand={demand}
          tally={tallies.get(demand.id)}
        />
      ))}
    </div>
  );
};

export const OffersTab = ({ view }: { view: MarketView }) => {
  const offers = [...view.offers.values()].toReversed();
  if (offers.length === 0) {
    return <Empty>No offer posted yet. Start the supplier agents.</Empty>;
  }
  const tallies = tallyBy(view.threads.values(), "offerId");
  return (
    <div className={POSTING_GRID}>
      {offers.map((offer) => (
        <OfferCard key={offer.id} offer={offer} tally={tallies.get(offer.id)} />
      ))}
    </div>
  );
};
