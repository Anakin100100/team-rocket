import { drizzle } from "drizzle-orm/node-postgres";

import type { DatabaseConfig } from "./config";
import { relations } from "./relations";

export const createDb = (env: DatabaseConfig) =>
  drizzle(env.DATABASE_URL, { relations });

export type Database = ReturnType<typeof createDb>;
