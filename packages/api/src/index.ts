import { ORPCError, os } from "@orpc/server";

import { isAppAdmin } from "./admin";
import type { Context } from "./context";

export const o = os.$context<Context>();

export const publicProcedure = o;

const requireAuth = o.middleware(({ context, next }) => {
  if (!context.session?.user) {
    throw new ORPCError("UNAUTHORIZED");
  }
  return next({
    context: {
      session: context.session,
    },
  });
});

export const protectedProcedure = publicProcedure.use(requireAuth);

// App admins: owners/admins of the ADMIN_ORGANIZATION_SLUG organization.
export const adminProcedure = protectedProcedure.use(
  async ({ context, next }) => {
    const isAdmin = await isAppAdmin(
      context.db,
      context.session.user.id,
      context.adminOrganizationSlug
    );
    if (!isAdmin) {
      throw new ORPCError("FORBIDDEN");
    }
    return next();
  }
);
