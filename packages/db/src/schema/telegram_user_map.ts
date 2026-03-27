import { pgTable, text, timestamp, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const telegramUserMap = pgTable(
  "telegram_user_map",
  {
    telegramChatId: text("telegram_chat_id").primaryKey(),
    telegramUsername: text("telegram_username"),
    telegramDisplayName: text("telegram_display_name"),
    paperclipUserId: text("paperclip_user_id"),
    paperclipCompanyId: text("paperclip_company_id"),
    role: text("role").notNull().default("member"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("telegram_user_map_company_idx").on(table.paperclipCompanyId),
    paperclipUserIdx: index("telegram_user_map_paperclip_user_idx").on(table.paperclipUserId),
  }),
);
