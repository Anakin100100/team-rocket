import { viewPaths } from "@better-auth-ui/core";

import { organizationPlugin } from "@/lib/auth/organization-plugin";

const organizationViewPaths = organizationPlugin().viewPaths;

// Path segments each catch-all route accepts: the core views plus the ones the
// organization plugin adds.
export const authPaths = new Set([
  ...Object.values(viewPaths.auth),
  ...Object.values(organizationViewPaths.auth),
]);

export const settingsPaths = new Set([
  ...Object.values(viewPaths.settings),
  ...Object.values(organizationViewPaths.settings),
]);

export const organizationPaths = new Set(
  Object.values(organizationViewPaths.organization)
);
