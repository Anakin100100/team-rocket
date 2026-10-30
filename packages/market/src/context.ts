import type { Database } from "@rocket/db";

export interface MarketContext {
  db: Database;
}

export type Executor =
  | Database
  | Parameters<Parameters<Database["transaction"]>[0]>[0];

// Who is asking. Visibility is enforced in code, never in prompts:
// a supplier only ever sees its own band, quotes, rank and counter.
export type Viewer =
  | { role: "observer" }
  | { role: "buyer" }
  | { role: "supplier"; supplierId: string };

export const viewerFromAs = (as: string): Viewer =>
  as === "buyer" ? { role: "buyer" } : { role: "supplier", supplierId: as };
