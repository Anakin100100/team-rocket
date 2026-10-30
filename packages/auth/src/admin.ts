import type { Database } from "@rocket/db";
import { member, organization } from "@rocket/db/schema/auth";
import { and, eq } from "drizzle-orm";

const ADMIN_ROLES = new Set(["owner", "admin"]);

// The developers are the owners and admins of one organization
// (ADMIN_ORGANIZATION_SLUG); they can read feedback from every user.
export const isAppAdmin = async (
  db: Database,
  userId: string,
  adminOrganizationSlug: string
) => {
  const memberships = await db
    .select({ role: member.role })
    .from(member)
    .innerJoin(organization, eq(member.organizationId, organization.id))
    .where(
      and(
        eq(member.userId, userId),
        eq(organization.slug, adminOrganizationSlug)
      )
    );
  // Better Auth stores multiple roles as a comma-separated list.
  return memberships.some(({ role }) =>
    role.split(",").some((name) => ADMIN_ROLES.has(name.trim()))
  );
};
