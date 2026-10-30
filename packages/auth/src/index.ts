import { drizzleAdapter } from "@better-auth/drizzle-adapter/relations-v2";
import type { Database } from "@rocket/db";
import * as schema from "@rocket/db/schema/auth";
import { betterAuth } from "better-auth";
import { organization } from "better-auth/plugins/organization";
import { eq } from "drizzle-orm";

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
}

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
      organization({
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
    ],
  });
};

export type Session = ReturnType<typeof createAuth>["$Infer"]["Session"];
