import type { Bot } from "grammy";

export interface TelegramUser {
  telegramChatId: string;
  telegramUsername: string | null;
  telegramDisplayName: string | null;
  paperclipUserId: string | null;
  paperclipCompanyId: string | null;
  role: string;
}

export interface ChatContext {
  direction: string;
  rawText: string | null;
  paperclipIssueId: string | null;
  createdAt: Date;
}

export interface TelegramServiceDeps {
  db: any;
  heartbeatService: any;
  publicUrl: string;
}

export interface TelegramService {
  start(): Promise<void>;
  stop(): void;
}

export type TelegramBot = Bot;
