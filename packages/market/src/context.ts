import type { Database } from "@rocket/db";

import type { ActorKind } from "./constants";

export interface MarketContext {
  db: Database;
}

export type Executor =
  | Database
  | Parameters<Parameters<Database["transaction"]>[0]>[0];

// Who is calling. Identity comes from the connection (a persona token or a
// signed-in human), never from tool arguments (plan.md §4.1, §5.1).
export interface Actor {
  kind: ActorKind;
  // Buyer or supplier id; null for observers.
  entityId: string | null;
  name: string;
  // Set for persona tokens, so `wait` can record that the agent is online.
  tokenHash?: string;
}

export const actorLabel = (actor: Actor) =>
  actor.entityId
    ? `${actor.kind}:${actor.entityId}`
    : `${actor.kind}:${actor.name}`;
