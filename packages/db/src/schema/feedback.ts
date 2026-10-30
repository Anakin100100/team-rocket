import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";

import { user } from "./auth";

// Feedback users send to the developers (via the MCP `send_feedback` tool).
export const feedback = pgTable(
  "feedback",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("feedback_createdAt_idx").on(table.createdAt)]
);
