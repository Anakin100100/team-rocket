import { createFileRoute, notFound, redirect } from "@tanstack/react-router";
import { z } from "zod";

import { Auth } from "@/components/auth/auth";
import { authClient } from "@/lib/auth-client";
import { authPaths } from "@/lib/auth-view-paths";

const ACCEPT_INVITATION_PATH = "accept-invitation";

// TanStack Router JSON-parses search values (`signup=1` arrives as a number),
// so coerce to strings. Loose so view-specific params (token, error) pass
// through; Better Auth UI reads those straight from the URL.
// zod's `.catch` (fallback on parse failure), not a promise chain.
// oxlint-disable-next-line promise/prefer-await-to-then, unicorn/no-useless-undefined
const searchString = z.coerce.string().optional().catch(undefined);
const authSearchSchema = z.looseObject({
  redirectTo: searchString,
  invitationId: searchString,
  // Set by the server on invitation links for emails without an account.
  signup: searchString,
  email: searchString,
});

const RouteComponent = () => {
  const { path } = Route.useParams();

  return (
    <div className="flex items-start justify-center p-4 md:p-8">
      <Auth path={path} />
    </div>
  );
};

export const Route = createFileRoute("/auth/$path")({
  validateSearch: authSearchSchema,
  beforeLoad: async ({ params, search }) => {
    if (!authPaths.has(params.path)) {
      throw notFound();
    }

    // Better Auth UI sends signed-out invitees to sign-in; someone invited
    // without an account needs sign-up, then a return to the invitation.
    const isNewInvitee =
      params.path === ACCEPT_INVITATION_PATH &&
      search.signup === "1" &&
      search.invitationId !== undefined;
    if (!isNewInvitee) {
      return;
    }
    const { data: session } = await authClient.getSession();
    if (session) {
      return;
    }
    throw redirect({
      to: "/auth/$path",
      params: { path: "sign-up" },
      search: {
        email: search.email,
        redirectTo: `/auth/${ACCEPT_INVITATION_PATH}?invitationId=${encodeURIComponent(search.invitationId ?? "")}`,
      },
      replace: true,
    });
  },
  component: RouteComponent,
});
