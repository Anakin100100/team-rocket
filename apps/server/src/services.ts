import { createAuth } from "@rocket/auth";
import { createDb } from "@rocket/db";
import { createAgentConfig } from "@rocket/market";
import { waitUntil } from "@vercel/functions";

import { ENV } from "./env.server";

export const db = createDb(ENV);
export const auth = createAuth(ENV, db, { runInBackground: waitUntil });

export const market = { db };
export const agents = createAgentConfig({
  apiKey: ENV.ANTHROPIC_API_KEY,
  model: ENV.MARKET_MODEL,
  effort: ENV.MARKET_EFFORT,
  mockBuyer: ENV.MOCK_BUYER,
  mockSuppliers: ENV.MOCK_SUPPLIERS,
});
