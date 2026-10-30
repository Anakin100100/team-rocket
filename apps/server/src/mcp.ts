import { requireMcpAuth } from "@better-auth/mcp";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { getMcpResource } from "@rocket/auth";

import { ENV } from "./env.server";
import { auth, db } from "./services";

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
