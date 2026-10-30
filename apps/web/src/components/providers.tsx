import { TooltipProvider } from "@rocket/ui/components/tooltip";
import type { QueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import type { ComponentProps, ReactNode } from "react";

import { AuthProvider } from "@/components/auth/auth-provider";
import { ThemeProvider } from "@/components/theme-provider";
import { authClient } from "@/lib/auth-client";
import { organizationPlugin } from "@/lib/auth/organization-plugin";

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

const authPlugins = [organizationPlugin()];

export const Providers = ({
  children,
  queryClient,
}: {
  children: ReactNode;
  queryClient: QueryClient;
}) => {
  const navigate = useNavigate();

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
