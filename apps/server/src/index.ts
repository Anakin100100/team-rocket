import { serve } from "@hono/node-server";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { OpenAPIReferencePlugin } from "@orpc/openapi/plugins";
import { onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { appRouter } from "@rocket/api/routers/index";
import { isAppAdmin } from "@rocket/auth/admin";
import { eventsFor } from "@rocket/market";
import type { Actor } from "@rocket/market";
import { isAPIError } from "better-auth/api";
import { initLogger } from "evlog";
import { createAuthMiddleware } from "evlog/better-auth";
import type { BetterAuthInstance } from "evlog/better-auth";
import { createFsDrain } from "evlog/fs";
import { evlog } from "evlog/hono";
import type { EvlogVariables } from "evlog/hono";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import { createContext } from "./context";
import { ENV } from "./env.server";
import { handleMcpRequest } from "./mcp";
import { auth, db } from "./services";

initLogger({
  env: { service: "rocket-server" },
});

const identifyUser = createAuthMiddleware(auth as BetterAuthInstance, {
  exclude: ["/api/auth/**"],
  maskEmail: true,
});

const OBSERVER: Actor = { kind: "observer", entityId: null, name: "admin-ui" };

const app = new Hono<EvlogVariables>();

app.use(
  evlog({
    drain: process.env.NODE_ENV === "production" ? undefined : createFsDrain(),
  })
);
app.use("*", async (c, next) => {
  await identifyUser(c.get("log"), c.req.raw.headers, c.req.path);
  await next();
});

app.use(
  "/*",
  cors({
    origin: ENV.CORS_ORIGIN,
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  })
);

app.on(["POST", "GET"], "/api/auth/*", (c) => auth.handler(c.req.raw));

// OAuth discovery for MCP clients (RFC 8414 / RFC 9728), answered by Better Auth.
app.on(["GET", "HEAD"], "/.well-known/*", (c) => auth.handler(c.req.raw));
app.all("/api/mcp", (c) => handleMcpRequest(c.req.raw));

const MAX_EVENTS_PAGE = 500;

// The admin UI's only input (plan.md §6): every market event after the cursor,
// with sealed limits. Read only and public, like the rest of the demo path.
app.get("/api/events", async (c) => {
  const since = Math.max(0, Number(c.req.query("since") ?? 0) || 0);
  const limit = Math.min(
    MAX_EVENTS_PAGE,
    Math.max(
      1,
      Number(c.req.query("limit") ?? MAX_EVENTS_PAGE) || MAX_EVENTS_PAGE
    )
  );
  return c.json(await eventsFor(db, OBSERVER, { since, limit }));
});

const API_REFERENCE_PREFIX = "/api/api-reference";
const OPENAPI_SPEC_PATH = "/openapi.json";
// The docs page and the spec are admin-only; the REST routes under the same
// prefix keep their own per-procedure auth.
const ADMIN_ONLY_PATHS = new Set([
  API_REFERENCE_PREFIX,
  `${API_REFERENCE_PREFIX}/`,
  `${API_REFERENCE_PREFIX}${OPENAPI_SPEC_PATH}`,
]);

export const apiHandler = new OpenAPIHandler(appRouter, {
  plugins: [
    new OpenAPIReferencePlugin({
      schemaConverters: [new ZodToJsonSchemaConverter()],
      specPath: OPENAPI_SPEC_PATH,
      specGenerateOptions: {
        info: { title: "Rocket API", version: "1.0.0" },
        servers: [
          { url: new URL(API_REFERENCE_PREFIX, ENV.BETTER_AUTH_URL).href },
        ],
        components: {
          securitySchemes: {
            apiKey: { type: "apiKey", in: "header", name: "x-api-key" },
          },
        },
        security: [{ apiKey: [] }],
      },
    }),
  ],
  interceptors: [
    onError((error) => {
      console.error(error);
    }),
  ],
});

export const rpcHandler = new RPCHandler(appRouter, {
  interceptors: [
    onError((error) => {
      console.error(error);
    }),
  ],
});

app.use("/*", async (c, next) => {
  let context: Awaited<ReturnType<typeof createContext>>;
  try {
    context = await createContext({ context: c });
  } catch (error) {
    // e.g. an invalid `x-api-key` (INVALID_API_KEY) is a 401, not a 500.
    if (isAPIError(error)) {
      return c.json(
        error.body ?? { message: error.message },
        error.statusCode as ContentfulStatusCode
      );
    }
    throw error;
  }

  const rpcResult = await rpcHandler.handle(c.req.raw, {
    prefix: "/api/rpc",
    context,
  });

  if (rpcResult.matched) {
    return c.newResponse(rpcResult.response.body, rpcResult.response);
  }

  if (ADMIN_ONLY_PATHS.has(c.req.path)) {
    if (!context.session) {
      return c.json({ message: "Sign in or send an admin API key." }, 401);
    }
    const isAdmin = await isAppAdmin(
      context.db,
      context.session.user.id,
      context.adminOrganizationSlug
    );
    if (!isAdmin) {
      return c.json({ message: "Admins only." }, 403);
    }
  }

  const apiResult = await apiHandler.handle(c.req.raw, {
    prefix: API_REFERENCE_PREFIX,
    context,
  });

  if (apiResult.matched) {
    return c.newResponse(apiResult.response.body, apiResult.response);
  }

  await next();
});

app.get("/", (c) => c.text("OK"));

export default app;

if (!process.env.VERCEL) {
  serve(
    {
      fetch: app.fetch,
      port: 3000,
    },
    (info) => {
      console.log(`Server is running on http://localhost:${info.port}`);
    }
  );
}
