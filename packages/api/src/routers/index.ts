import type { RouterClient } from "@orpc/server";

import { publicProcedure } from "../index";
import { feedbackRouter } from "./feedback";

export const appRouter = {
  healthCheck: publicProcedure.handler(() => "OK"),
  feedback: feedbackRouter,
};
export type AppRouter = typeof appRouter;
export type AppRouterClient = RouterClient<typeof appRouter>;
