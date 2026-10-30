import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";
import react from "ultracite/oxlint/react";
import tanstack from "ultracite/oxlint/tanstack";

export default defineConfig({
  extends: [core, react, tanstack],
  ignorePatterns: [
    ...core.ignorePatterns,
    // Vendored agent skills are third-party assets, not project source.
    "**/.agents",
    "**/.claude",
    // Registry-managed UI (shadcn components, Better Auth UI). Kept as upstream
    // ships it so `shadcn add --diff`/`--overwrite` updates stay clean.
    "packages/ui/src/components/**",
    "apps/web/src/components/auth/**",
    "apps/web/src/lib/auth/**",
    // Generated API clients (scripts/generate-python-client.sh).
    "clients/**",
  ],
  overrides: [
    {
      // Hono middleware must `await next()` rather than return it, and oRPC's
      // `onError` interceptor is a hook, not a Node-style callback.
      files: ["apps/server/**"],
      rules: {
        "node/callback-return": "off",
        "promise/prefer-await-to-callbacks": "off",
      },
    },
  ],
});
