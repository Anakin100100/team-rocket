import { useSession } from "@better-auth-ui/react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import { OrganizationSwitcher } from "@/components/auth/organization/organization-switcher";
import { UserButton } from "@/components/auth/user/user-button";
import { authClient } from "@/lib/auth-client";
import { orpc } from "@/utils/orpc";

import { ModeToggle } from "./mode-toggle";

const links = [
  { to: "/", label: "Home" },
  { to: "/dashboard", label: "Dashboard" },
] as const;

const Header = () => {
  const { data: session } = useSession(authClient);
  // Keyed by user so a different account never sees a cached answer.
  const canViewFeedback = useQuery({
    ...orpc.feedback.canView.queryOptions(),
    queryKey: [...orpc.feedback.canView.queryKey(), session?.user.id],
    enabled: Boolean(session),
  });

  return (
    <div>
      <div className="flex flex-row items-center justify-between px-2 py-1">
        <nav className="flex gap-4 text-lg">
          {links.map(({ to, label }) => (
            <Link key={to} to={to}>
              {label}
            </Link>
          ))}
          {canViewFeedback.data === true && (
            <Link to="/feedback">Feedback</Link>
          )}
        </nav>
        <div className="flex items-center gap-2">
          {session && <OrganizationSwitcher hideCreate />}
          <ModeToggle />
          <UserButton />
        </div>
      </div>
      <hr />
    </div>
  );
};

export default Header;
