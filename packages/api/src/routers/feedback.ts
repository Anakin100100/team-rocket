import { user } from "@rocket/db/schema/auth";
import { feedback } from "@rocket/db/schema/feedback";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";

import { adminProcedure } from "../index";

const feedbackItem = z.object({
  id: z.string(),
  text: z.string(),
  createdAt: z.date(),
  name: z.string(),
  email: z.string(),
});

export const feedbackRouter = {
  list: adminProcedure.output(z.array(feedbackItem)).handler(({ context }) =>
    context.db
      .select({
        id: feedback.id,
        text: feedback.text,
        createdAt: feedback.createdAt,
        name: user.name,
        email: user.email,
      })
      .from(feedback)
      .innerJoin(user, eq(feedback.userId, user.id))
      .orderBy(desc(feedback.createdAt))
  ),
};
