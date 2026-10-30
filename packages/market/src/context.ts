import type { Database } from "@rocket/db";

import type { ActorKind, Side } from "./constants";

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
  // The buyer or supplier id. A trader's one id is both; null for observers
  // and for a trader who has not named a company yet.
  entityId: string | null;
  name: string;
  // Set for persona tokens, so `wait` can record that the agent is online.
  tokenHash?: string;
  // Set for signed-in users (traders): their limits and company hang off it.
  userId?: string;
}

// Personas act on one side; a trader acts on both.
export const actsAs = (actor: Actor, side: Side) =>
  actor.kind === side || actor.kind === "trader";

export const actorLabel = (actor: Actor) =>
  actor.entityId
    ? `${actor.kind}:${actor.entityId}`
    : `${actor.kind}:${actor.name}`;
