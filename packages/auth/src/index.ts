import { apiKey } from "@better-auth/api-key";
import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { drizzleAdapter } from "@better-auth/drizzle-adapter/relations-v2";
import { mcp } from "@better-auth/mcp";
import type { Database } from "@rocket/db";
import * as schema from "@rocket/db/schema/auth";
import { betterAuth } from "better-auth";
import {
  APIError,
  createAuthMiddleware,
  getSessionFromCtx,
} from "better-auth/api";
import { admin } from "better-auth/plugins/admin";
import { jwt } from "better-auth/plugins/jwt";
import { organization } from "better-auth/plugins/organization";
import { and, eq, gt } from "drizzle-orm";

import { isAppAdmin } from "./admin";
import {
  createEmailSender,
  invitationEmail,
  resetPasswordEmail,
  verificationEmail,
} from "./email";
import type { EmailConfig } from "./email";

export interface AuthConfig extends EmailConfig {
  BETTER_AUTH_URL: string;
  BETTER_AUTH_SECRET: string;
  CORS_ORIGIN: string;
  // Owners/admins of this organization are app admins (see `isAppAdmin`).
  ADMIN_ORGANIZATION_SLUG: string;
}

// The MCP endpoint on the API server; OAuth access tokens are audience-bound to it.
export const getMcpResource = (env: Pick<AuthConfig, "BETTER_AUTH_URL">) =>
  new URL("/api/mcp", env.BETTER_AUTH_URL).href;

export interface AuthOptions {
  desktopOrigins?: readonly string[];
  // Keeps deferred work such as email sends alive after the response is sent
  // (e.g. Vercel's `waitUntil`), so response timing doesn't reveal whether an
  // account exists.
  runInBackground?: (promise: Promise<unknown>) => void;
}

export const createAuth = (
  env: AuthConfig,
  database: Database,
  { desktopOrigins = [], runInBackground }: AuthOptions = {}
) => {
  const sendEmail = createEmailSender(env);

  const hasAccount = async (email: string) => {
    const [existing] = await database
      .select({ id: schema.user.id })
      .from(schema.user)
      .where(eq(schema.user.email, email.toLowerCase()))
      .limit(1);
    return existing !== undefined;
  };

  const hasPendingInvitation = async (email: string) => {
    const [pending] = await database
      .select({ id: schema.invitation.id })
      .from(schema.invitation)
      .where(
        and(
          eq(schema.invitation.email, email.toLowerCase()),
          eq(schema.invitation.status, "pending"),
          gt(schema.invitation.expiresAt, new Date())
        )
      )
      .limit(1);
    return pending !== undefined;
  };

  // New invitees are sent to sign-up (with their email prefilled) instead of
  // sign-in. Decided here, so the app never exposes an account lookup.
  const invitationUrl = async (invitationId: string, email: string) => {
    const url = new URL("/auth/accept-invitation", env.CORS_ORIGIN);
    url.searchParams.set("invitationId", invitationId);
    const isNewUser = !(await hasAccount(email));
    if (isNewUser) {
      url.searchParams.set("signup", "1");
      url.searchParams.set("email", email);
    }
    return { url: url.toString(), isNewUser };
  };

  return betterAuth({
    database: drizzleAdapter(database, {
      provider: "pg",
      schema,
    }),
    trustedOrigins: [env.CORS_ORIGIN, ...desktopOrigins],
    emailAndPassword: {
      enabled: true,
      sendResetPassword: ({ user, url }) =>
        sendEmail(resetPasswordEmail(user.email, url)),
    },
    hooks: {
      // Accounts are invite-only: self sign-up is open only to emails with a
      // pending invitation. Server-side creation (admin `createUser`) is unaffected.
      // API keys act as their owner on every endpoint, so only app admins may
      // create them. Server-side creation (no session, explicit `userId`) is
      // a system action and stays allowed.
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path === "/sign-up/email") {
          const email: unknown = ctx.body?.email;
          if (
            typeof email !== "string" ||
            !(await hasPendingInvitation(email))
          ) {
            throw new APIError("FORBIDDEN", {
              message: "Sign-up is by invitation only.",
            });
          }
        }
        if (ctx.path === "/api-key/create") {
          const session = await getSessionFromCtx(ctx);
          const isAdmin =
            session !== null &&
            (await isAppAdmin(
              database,
              session.user.id,
              env.ADMIN_ORGANIZATION_SLUG
            ));
          if (session && !isAdmin) {
            throw new APIError("FORBIDDEN", {
              message: "Only admins can create API keys.",
            });
          }
        }
      }),
    },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      sendVerificationEmail: ({ user, url }) =>
        sendEmail(verificationEmail(user.email, url)),
    },
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    advanced: {
      defaultCookieAttributes: {
        sameSite: "none",
        secure: true,
        httpOnly: true,
      },
      ...(runInBackground && {
        backgroundTasks: { handler: runInBackground },
      }),
    },
    plugins: [
      // Server-side user management (e.g. `createUser` for invite-only accounts).
      admin(),
      // Admin API keys (`x-api-key` header). A key is a session for its owner,
      // so it reaches every endpoint the owner can. The default per-key limit
      // (10 requests/day) would make that useless.
      apiKey({
        enableSessionForAPIKeys: true,
        rateLimit: { enabled: false },
      }),
      organization({
        // Organizations are provisioned by the app (server-side `createOrganization`
        // with a `userId`, which Better Auth treats as a system action), not by users.
        allowUserToCreateOrganization: false,
        sendInvitationEmail: async ({
          id,
          email,
          organization: org,
          inviter,
        }) => {
          const { url, isNewUser } = await invitationUrl(id, email);
          await sendEmail(
            invitationEmail({
              to: email,
              inviterName: inviter.user.name,
              organizationName: org.name,
              url,
              isNewUser,
            })
          );
        },
      }),
      // MCP clients sign users in through this app (OAuth 2.1). `mcp()` is the
      // OAuth provider and needs `jwt()` for signing keys and `/jwks`.
      jwt(),
      mcp({
        // Absolute: the web app and the API run on different origins locally.
        loginPage: new URL("/auth/sign-in", env.CORS_ORIGIN).href,
        consentPage: new URL("/oauth/consent", env.CORS_ORIGIN).href,
        resource: getMcpResource(env),
        // Open dynamic registration (RFC 7591) for MCP clients without CIMD
        // support (e.g. Cursor, Codex). A registered client can't do anything
        // until an existing user signs in and approves it on the consent page.
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        // Cursor registers a `cursor://` redirect without `application_type`;
        // the default ("web") rejects that, so treat such clients as native.
        clientRegistrationDefaultApplicationType: "infer",
      }),
      // MCP clients that support it identify themselves with a Client ID
      // Metadata Document URL instead of registering dynamically.
      cimd({
        fetchClientMetadataResource,
        metadataProfile: "mcp-2026-07-28",
      }),
    ],
  });
};

export type Session = ReturnType<typeof createAuth>["$Infer"]["Session"];
