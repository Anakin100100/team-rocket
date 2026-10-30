import { useSession } from "@better-auth-ui/react";
import { Link } from "@tanstack/react-router";

import { OrganizationSwitcher } from "@/components/auth/organization/organization-switcher";
import { UserButton } from "@/components/auth/user/user-button";
import { authClient } from "@/lib/auth-client";

import { ModeToggle } from "./mode-toggle";

const links = [
  { to: "/", label: "Home" },
  { to: "/dashboard", label: "Dashboard" },
  { to: "/todos", label: "Todos" },
] as const;

const Header = () => {
  const { data: session } = useSession(authClient);

  return (
    <div>
      <div className="flex flex-row items-center justify-between px-2 py-1">
        <nav className="flex gap-4 text-lg">
          {links.map(({ to, label }) => (
            <Link key={to} to={to}>
              {label}
            </Link>
          ))}
        </nav>
        <div className="flex items-center gap-2">
          {session && <OrganizationSwitcher />}
          <ModeToggle />
          <UserButton />
        </div>
      </div>
      <hr />
    </div>
  );
};

export default Header;
