import { user } from "@rocket/db/schema/auth";
import { feedback } from "@rocket/db/schema/feedback";
import { desc, eq } from "drizzle-orm";

import { isAppAdmin } from "../admin";
import { adminProcedure, protectedProcedure } from "../index";

export const feedbackRouter = {
  // Whether the signed-in user may open the feedback panel.
  canView: protectedProcedure.handler(({ context }) =>
    isAppAdmin(
      context.db,
      context.session.user.id,
      context.adminOrganizationSlug
    )
  ),
  list: adminProcedure.handler(({ context }) =>
    context.db
      .select({
        id: feedback.id,
        text: feedback.text,
        createdAt: feedback.createdAt,
        name: user.name,
        email: user.email,
      })
      .from(feedback)
      .innerJoin(user, eq(feedback.userId, user.id))
      .orderBy(desc(feedback.createdAt))
  ),
};
