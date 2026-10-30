import { requireMcpAuth } from "@better-auth/mcp";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { getMcpResource } from "@rocket/auth";
import { feedback } from "@rocket/db/schema/feedback";
import { marketTools, runTool } from "@rocket/market";
import { z } from "zod";

import { ENV } from "./env.server";
import { auth, db, market } from "./services";

const FEEDBACK_MAX_LENGTH = 5000;

const textResult = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});

const mcpHandler = createMcpHandler(({ authInfo }) => {
  // `requireMcpAuth` verified the token; its subject is the signed-in user.
  const userId = String(authInfo?.extra?.userId ?? "");
  const server = new McpServer({ name: "rocket", version: "1.0.0" });

  server.registerTool(
    "whoami",
    {
      title: "Who am I",
      description: "The Rocket user this MCP connection is signed in as.",
      annotations: { readOnlyHint: true },
    },
    async () => {
      const user = await db.query.user.findFirst({
        where: { id: userId },
        columns: { id: true, name: true, email: true },
      });
      return textResult(user ?? null);
    }
  );

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

  // The marketplace (plan.md §4): the same tools the agents use in-process.
  // A human in an MCP client can browse the market, act as the buyer or play
  // any supplier; the market's guards and visibility rules apply unchanged.
  for (const tool of marketTools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.input,
        annotations: { readOnlyHint: tool.kind === "read" },
      },
      async (args: unknown) => {
        const outcome = await runTool(market, tool.name, args);
        return outcome.ok
          ? textResult(outcome.result)
          : { ...textResult({ error: outcome.error }), isError: true };
      }
    );
  }

  return server;
});

export const handleMcpRequest = requireMcpAuth(
  auth,
  (request, claims) =>
    mcpHandler.fetch(request, {
      authInfo: {
        token: request.headers.get("authorization")?.split(" ")[1] ?? "",
        clientId: String(claims.azp ?? ""),
        scopes: typeof claims.scope === "string" ? claims.scope.split(" ") : [],
        expiresAt: claims.exp,
        extra: { userId: claims.sub },
      },
    }),
  { resource: getMcpResource(ENV) }
);
