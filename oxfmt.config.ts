import { defineConfig } from "oxfmt";
import ultracite from "ultracite/oxfmt";

export default defineConfig({
  ...ultracite,
  ignorePatterns: [
    ...ultracite.ignorePatterns,
    // Vendored agent skills are third-party assets, not project source.
    "**/.agents",
    "**/.claude",
    // Registry-managed UI (shadcn components, Better Auth UI). Kept as upstream
    // ships it so `shadcn add --diff`/`--overwrite` updates stay clean.
    "packages/ui/src/components/**",
    "apps/web/src/components/auth/**",
    "apps/web/src/lib/auth/**",
  ],
});
