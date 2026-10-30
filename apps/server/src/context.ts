import type { Context as ApiContext } from "@rocket/api/context";
import type { Context as HonoContext } from "hono";

import { ENV } from "./env.server";
import { agents, db, auth } from "./services";

export interface CreateContextOptions {
  context: HonoContext;
}

export const createContext = async ({
  context,
}: CreateContextOptions): Promise<ApiContext> => {
  const session = await auth.api.getSession({
    headers: context.req.raw.headers,
  });
  return {
    db,
    session,
    adminOrganizationSlug: ENV.ADMIN_ORGANIZATION_SLUG,
    agents,
  };
};

export type Context = Awaited<ReturnType<typeof createContext>>;
