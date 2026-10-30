import { sql } from "drizzle-orm";

import type { MarketContext } from "./context";

export type Tx = Parameters<
  Parameters<MarketContext["db"]["transaction"]>[0]
>[0];

// Market writes run one at a time: each transaction takes this lock first and
// holds it until commit. Reads never take it. One lock is what keeps the
// check-then-insert guards honest (one open demand per listing, one open offer
// per class), lets matching see every posting, keeps a new thread from opening
// on a demand or offer that is being filled, stops two accepts from closing
// the same threads twice, and makes event ids commit in order, so a `wait`
// cursor never steps over an event that commits late.
const MARKET_WRITE_LOCK = 0x6d_61_72_6b_65_74;

export const marketWrite = <T>(
  db: MarketContext["db"],
  write: (tx: Tx) => Promise<T>
) =>
  db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${MARKET_WRITE_LOCK})`);
    return write(tx);
  });
