import type { Session } from "@rocket/auth";
import type { Database } from "@rocket/db";

export interface Context {
  session: Session | null;
  db: Database;
}
