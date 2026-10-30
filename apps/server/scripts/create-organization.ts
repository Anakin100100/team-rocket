// Users can't create organizations themselves (`allowUserToCreateOrganization:
// false`); this creates one for an existing account, which becomes its owner.
//
// Usage: bun run org:create -- --name <name> --owner <email> [--slug <slug>]
// Runs against whatever DATABASE_URL / BETTER_AUTH_URL the environment resolves.
import { parseArgs } from "node:util";

import { user } from "@rocket/db/schema/auth";
import { eq } from "drizzle-orm";

import { auth, db } from "../src/services";

const SLUG_INVALID_CHARS = /[^a-z0-9]+/gu;
const SLUG_EDGE_DASHES = /^-|-$/gu;

const { values } = parseArgs({
  options: {
    name: { type: "string" },
    owner: { type: "string" },
    slug: { type: "string" },
  },
});

if (!(values.name && values.owner)) {
  console.error(
    "Usage: bun run org:create -- --name <name> --owner <email> [--slug <slug>]"
  );
  process.exit(1);
}

const slug =
  values.slug ??
  values.name
    .toLowerCase()
    .replaceAll(SLUG_INVALID_CHARS, "-")
    .replaceAll(SLUG_EDGE_DASHES, "");

const [owner] = await db
  .select({ id: user.id, email: user.email })
  .from(user)
  .where(eq(user.email, values.owner.toLowerCase()))
  .limit(1);

if (!owner) {
  console.error(`No account with email ${values.owner}.`);
  process.exit(1);
}

// No session plus a `userId` is a system action, so it bypasses the
// user-creation restriction.
const organization = await auth.api.createOrganization({
  body: {
    name: values.name,
    slug,
    userId: owner.id,
    keepCurrentActiveOrganization: true,
  },
});

console.log(
  `Created organization "${organization?.name}" (slug: ${organization?.slug}) owned by ${owner.email}.`
);
process.exit(0);
