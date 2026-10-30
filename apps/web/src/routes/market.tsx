// Admin UI for the agent marketplace (plan.md §6): read only, rebuilt from the
// event log, polled twice a second. No forms: the agents are already trading.
// One tab per concern: aggregates, demands, matches, offers. The open tab is
// in the URL so a refresh or a shared link lands on it.
import { Badge } from "@rocket/ui/components/badge";
import { Button } from "@rocket/ui/components/button";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@rocket/ui/components/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@rocket/ui/components/tooltip";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { MarketDashboard } from "@/components/market/market-dashboard";
import { MatchesTab } from "@/components/market/matches";
import { DemandsTab, OffersTab } from "@/components/market/postings";
import { formatDateTime } from "@/components/market/state";
import { useMarketFeed } from "@/components/market/use-market-feed";
import { orpc } from "@/utils/orpc";

const AGENTS_POLL_MS = 500;

const TABS = ["dashboard", "demands", "matches", "offers"] as const;
type MarketTab = (typeof TABS)[number];
const DEFAULT_TAB: MarketTab = "dashboard";

const parseTab = (value: unknown) => TABS.find((tab) => tab === value);

const Count = ({ value }: { value: number }) => (
  <span className="text-muted-foreground tabular-nums">{value}</span>
);

const MarketPage = () => {
  const feed = useMarketFeed();
  const { replay: handleReplay, stopReplay: handleStopReplay } = feed;
  const tab = Route.useSearch().tab ?? DEFAULT_TAB;
  const navigate = useNavigate({ from: Route.fullPath });
  const agents = useQuery({
    ...orpc.market.agents.queryOptions(),
    refetchInterval: AGENTS_POLL_MS,
  });

  const { view } = feed;
  const fetchedAt = [...view.demands.values()].find(
    (demand) => demand.fetchedAt
  )?.fetchedAt;
  const online = agents.data?.filter((agent) => agent.online) ?? [];
  const live = [...view.threads.values()].filter(
    (thread) => thread.state === "open"
  ).length;

  const handleTabChange = (value: unknown) => {
    const next = parseTab(value) ?? DEFAULT_TAB;
    navigate({
      search: next === DEFAULT_TAB ? {} : { tab: next },
      replace: true,
    });
  };

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

      <Tabs value={tab} onValueChange={handleTabChange}>
        <TabsList>
          <TabsTrigger value="dashboard">Dashboard</TabsTrigger>
          <TabsTrigger value="demands">
            Demands <Count value={view.demands.size} />
          </TabsTrigger>
          <TabsTrigger value="matches">
            Matches <Count value={view.threads.size} />
            {live > 0 && <Badge className="tabular-nums">{live} live</Badge>}
          </TabsTrigger>
          <TabsTrigger value="offers">
            Offers <Count value={view.offers.size} />
          </TabsTrigger>
        </TabsList>
        <TabsContent value="dashboard" className="pt-2">
          <MarketDashboard
            view={view}
            events={feed.events}
            agents={agents.data}
            replaying={feed.replaying}
          />
        </TabsContent>
        <TabsContent value="demands" className="pt-2">
          <DemandsTab view={view} />
        </TabsContent>
        <TabsContent value="matches" className="pt-2">
          <MatchesTab view={view} />
        </TabsContent>
        <TabsContent value="offers" className="pt-2">
          <OffersTab view={view} />
        </TabsContent>
      </Tabs>
    </div>
  );
};

export const Route = createFileRoute("/market")({
  validateSearch: (search: Record<string, unknown>): { tab?: MarketTab } => {
    const tab = parseTab(search.tab);
    return tab ? { tab } : {};
  },
  component: MarketPage,
});
