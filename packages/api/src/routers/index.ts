import type { RouterClient } from "@orpc/server";
import { isAppAdmin } from "@rocket/auth/admin";
import { z } from "zod";

import { publicProcedure } from "../index";
import { feedbackRouter } from "./feedback";
import { marketRouter } from "./market";

export const appRouter = {
  healthCheck: publicProcedure.output(z.string()).handler(() => "OK"),
  // Whether the caller is an app admin (feedback panel, API keys). Public so
  // signed-out callers get `false` instead of an error.
  isAdmin: publicProcedure
    .output(z.boolean())
    .handler(({ context }) =>
      context.session
        ? isAppAdmin(
            context.db,
            context.session.user.id,
            context.adminOrganizationSlug
          )
        : false
    ),
  feedback: feedbackRouter,
  market: marketRouter,
};
export type AppRouter = typeof appRouter;
export type AppRouterClient = RouterClient<typeof appRouter>;
