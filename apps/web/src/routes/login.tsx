import { createFileRoute, redirect } from "@tanstack/react-router";

// Sign-in moved to Better Auth UI's /auth/sign-in; keep old links working.
export const Route = createFileRoute("/login")({
  beforeLoad: () => {
    throw redirect({
      to: "/auth/$path",
      params: { path: "sign-in" },
      replace: true,
    });
  },
});
