import { createHash } from "node:crypto";

import { requireMcpAuth } from "@better-auth/mcp";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { getMcpResource } from "@rocket/auth";
import { feedback } from "@rocket/db/schema/feedback";
import { marketAgents } from "@rocket/db/schema/market";
import { marketTools, runTool } from "@rocket/market";
import type { Actor } from "@rocket/market";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { ENV } from "./env.server";
import { auth, db, market } from "./services";

const FEEDBACK_MAX_LENGTH = 5000;
const BEARER_PREFIX = "bearer ";

const textResult = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});

const hashToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");

const bearerToken = (request: Request) => {
  const header = request.headers.get("authorization") ?? "";
  return header.toLowerCase().startsWith(BEARER_PREFIX)
    ? header.slice(BEARER_PREFIX.length).trim()
    : "";
};

// Tools only signed-in humans get; persona agents see exactly the market.
const registerHumanTools = (server: McpServer, userId: string) => {
  server.registerTool(
    "list_organizations",
    {
      title: "List organizations",
      description: "Organizations the signed-in user belongs to, with roles.",
      annotations: { readOnlyHint: true },
    },
    async () => {
      const memberships = await db.query.member.findMany({
        where: { userId },
        with: {
          organization: { columns: { id: true, name: true, slug: true } },
        },
      });
      return textResult(
        memberships.map(({ role, organization }) => ({ ...organization, role }))
      );
    }
  );

  server.registerTool(
    "send_feedback",
    {
      title: "Send feedback",
      description:
        "Send feedback, a bug report or a feature request to the Rocket developers.",
      inputSchema: z.object({
        feedback: z
          .string()
          .trim()
          .min(1)
          .max(FEEDBACK_MAX_LENGTH)
          .describe("The feedback, in the user's own words."),
      }),
    },
    async ({ feedback: text }) => {
      await db.insert(feedback).values({ userId, text });
      return textResult("Thanks! Your feedback was sent to the Rocket team.");
    }
  );
};

const mcpHandler = createMcpHandler(({ authInfo }) => {
  const actor = authInfo?.extra?.actor as Actor;
  const userId = authInfo?.extra?.userId as string | undefined;
  const server = new McpServer({ name: "market", version: "1.0.0" });

  // The marketplace (plan.md §4.1): eleven tools, acting as the connection's
  // actor. Guards and visibility are enforced in the tools, not here.
  for (const tool of marketTools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.input,
        annotations: { readOnlyHint: tool.readOnly },
      },
      async (args: unknown) => {
        const outcome = await runTool(market, actor, tool.name, args);
        return outcome.ok
          ? textResult(outcome.result)
          : { ...textResult({ error: outcome.error }), isError: true };
      }
    );
  }
  if (userId) {
    registerHumanTools(server, userId);
  }
  return server;
});

// A signed-in human (OAuth) watches the market as an observer.
const handleHumanRequest = requireMcpAuth(
  auth,
  async (request, claims) => {
    const userId = String(claims.sub ?? "");
    const user = await db.query.user.findFirst({
      where: { id: userId },
      columns: { name: true },
    });
    const actor: Actor = {
      kind: "observer",
      entityId: null,
      name: user?.name ?? "observer",
    };
    return mcpHandler.fetch(request, {
      authInfo: {
        token: bearerToken(request),
        clientId: String(claims.azp ?? ""),
        scopes: typeof claims.scope === "string" ? claims.scope.split(" ") : [],
        expiresAt: claims.exp,
        extra: { actor, userId },
      },
    });
  },
  { resource: getMcpResource(ENV) }
);

// The persona door (plan.md §5.1): a bearer token whose hash is in
// `market_agents` runs as that buyer or supplier. Anything else goes through
// the OAuth door.
export const handleMcpRequest = async (request: Request) => {
  const token = bearerToken(request);
  if (token) {
    const tokenHash = hashToken(token);
    const [agent] = await db
      .select()
      .from(marketAgents)
      .where(eq(marketAgents.tokenHash, tokenHash));
    if (agent) {
      const actor: Actor = {
        kind: agent.kind as Actor["kind"],
        entityId: agent.entityId,
        name: agent.name,
        tokenHash,
      };
      return mcpHandler.fetch(request, {
        authInfo: {
          token,
          clientId: "market-persona",
          scopes: [],
          extra: { actor },
        },
      });
    }
  }
  return handleHumanRequest(request);
};
