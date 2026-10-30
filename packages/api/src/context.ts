import type { Session } from "@rocket/auth";
import type { Database } from "@rocket/db";

export interface Context {
  session: Session | null;
  db: Database;
  // Owners/admins of this organization are app admins (see `isAppAdmin`).
  adminOrganizationSlug: string;
}
