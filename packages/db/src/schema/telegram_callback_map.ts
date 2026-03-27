import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const telegramCallbackMap = pgTable(
  "telegram_callback_map",
  {
    shortId: text("short_id").primaryKey(),
    companyId: text("company_id").notNull(),
    approvalId: text("approval_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
);
