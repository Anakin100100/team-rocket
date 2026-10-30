import { TooltipProvider } from "@rocket/ui/components/tooltip";
import { useQuery } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";
import type { ComponentProps, ReactNode } from "react";

import { AuthProvider } from "@/components/auth/auth-provider";
import { ThemeProvider } from "@/components/theme-provider";
import { authClient } from "@/lib/auth-client";
import { apiKeyPlugin } from "@/lib/auth/api-key-plugin";
import { organizationPlugin } from "@/lib/auth/organization-plugin";
import { orpc } from "@/utils/orpc";

const AUTH_PATH_PREFIX = "/auth/";

const keepRedirectTo = (search: Record<string, unknown>) => ({
  redirectTo:
    typeof search.redirectTo === "string" ? search.redirectTo : undefined,
});

// Better Auth UI renders links with `href`; TanStack Router's Link takes `to`.
const AuthLink = ({
  href,
  ...props
}: Omit<ComponentProps<typeof Link>, "to"> & { href: string }) => {
  const authView = href.startsWith(AUTH_PATH_PREFIX)
    ? href.slice(AUTH_PATH_PREFIX.length)
    : undefined;

  if (authView && !authView.includes("?")) {
    // Links between auth views (e.g. sign-in → sign-up) drop the query string,
    // which would lose where to return to, such as a pending invitation.
    return (
      <Link
        {...props}
        to="/auth/$path"
        params={{ path: authView }}
        search={keepRedirectTo}
      />
    );
  }

  return <Link to={href} {...props} />;
};

// Mirrors the server's `allowUserToCreateOrganization: false`.
const basePlugins = [organizationPlugin({ allowOrganizationCreation: false })];
// Only app admins may create API keys (enforced by the server), so only they
// get the API Keys card in Settings → Security.
const adminPlugins = [...basePlugins, apiKeyPlugin()];

export const Providers = ({
  children,
  queryClient,
}: {
  children: ReactNode;
  queryClient: QueryClient;
}) => {
  const navigate = useNavigate();
  const { data: session } = authClient.useSession();
  // Keyed by user so a different account never sees a cached answer.
  const isAdmin = useQuery({
    ...orpc.isAdmin.queryOptions(),
    queryKey: [...orpc.isAdmin.queryKey(), session?.user.id],
    enabled: Boolean(session),
  });
  const authPlugins = useMemo(
    () => (isAdmin.data === true ? adminPlugins : basePlugins),
    [isAdmin.data]
  );

  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="dark"
      disableTransitionOnChange
      storageKey="vite-ui-theme"
    >
      <AuthProvider
        authClient={authClient}
        navigate={navigate}
        Link={AuthLink}
        queryClient={queryClient}
        // Email links (verify, reset) are opened via the API server, which can
        // run on another origin locally, so callbacks must be absolute.
        baseURL={window.location.origin}
        redirectTo="/dashboard"
        plugins={authPlugins}
      >
        <TooltipProvider>{children}</TooltipProvider>
      </AuthProvider>
    </ThemeProvider>
  );
};
