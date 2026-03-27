import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const telegramPollCursor = pgTable(
  "telegram_poll_cursor",
  {
    key: text("key").primaryKey(),
    value: text("value").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
);
