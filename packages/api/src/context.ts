import type { Session } from "@rocket/auth";
import type { Database } from "@rocket/db";
import type { AgentConfig } from "@rocket/market";

export interface Context {
  session: Session | null;
  db: Database;
  // Buyer/supplier agent settings (model, effort, mocks) for market actions.
  agents: AgentConfig;
  // Owners/admins of this organization are app admins (see `isAppAdmin`).
  adminOrganizationSlug: string;
}
