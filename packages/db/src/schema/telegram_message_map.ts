import { pgTable, text, serial, timestamp, index, uuid } from "drizzle-orm/pg-core";

export const telegramMessageMap = pgTable(
  "telegram_message_map",
  {
    id: serial("id").primaryKey(),
    telegramChatId: text("telegram_chat_id").notNull(),
    telegramMessageId: text("telegram_message_id").notNull(),
    direction: text("direction").notNull(), // 'inbound' | 'outbound'
    paperclipIssueId: text("paperclip_issue_id"),
    paperclipCommentId: text("paperclip_comment_id"),
    paperclipCompanyId: text("paperclip_company_id"),
    agentTaskSessionId: uuid("agent_task_session_id"),
    rawText: text("raw_text"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    chatCreatedIdx: index("idx_telegram_msg_chat").on(table.telegramChatId, table.createdAt),
    issueIdx: index("idx_telegram_msg_issue").on(table.paperclipIssueId),
  }),
);
