import { createAuth } from "@rocket/auth";
import { createDb } from "@rocket/db";

import { ENV } from "./env.server";

export const db = createDb(ENV);
export const auth = createAuth(ENV, db);
