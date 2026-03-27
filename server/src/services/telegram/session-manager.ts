import { telegramLog as log } from "./bot.js";

/**
 * Maps Telegram chatId → active issue + agent context.
 *
 * The actual multi-turn session is handled by agent_task_sessions in the
 * heartbeat service. The session manager simply tracks the mapping of
 * chatId → (issueId, companyId, agentId) so handlers know which issue
 * a chat is currently discussing.
 *
 * Session rotation and compaction are handled automatically by the
 * heartbeat's evaluateSessionCompaction logic.
 */

interface ActiveChat {
  issueId: string;
  companyId: string;
  agentId: string | null;
  lastActivityAt: number;
}

// In-memory map — lightweight since it's just routing state
const activeChatMap = new Map<string, ActiveChat>();

// Consider a chat "stale" after 30 minutes of inactivity
const STALE_THRESHOLD_MS = 30 * 60 * 1000;

/**
 * Record that a chat is actively discussing an issue.
 */
export function setActiveChat(
  chatId: string,
  issueId: string,
  companyId: string,
  agentId: string | null,
): void {
  activeChatMap.set(chatId, {
    issueId,
    companyId,
    agentId,
    lastActivityAt: Date.now(),
  });
}

/**
 * Get the active issue for a chat, or null if none / stale.
 */
export function getActiveChat(chatId: string): ActiveChat | null {
  const entry = activeChatMap.get(chatId);
  if (!entry) return null;
  if (Date.now() - entry.lastActivityAt > STALE_THRESHOLD_MS) {
    activeChatMap.delete(chatId);
    return null;
  }
  return entry;
}

/**
 * Clear a chat's active context (e.g., when user explicitly starts a new topic).
 */
export function clearActiveChat(chatId: string): void {
  activeChatMap.delete(chatId);
}

/**
 * Build the taskKey used for agent_task_sessions.
 * This allows the heartbeat to resume the same Claude session for a given chat.
 */
export function buildTaskKey(chatId: string): string {
  return `telegram:chat:${chatId}`;
}

/**
 * Periodic cleanup of stale entries.
 */
export function cleanupStaleSessions(): number {
  const now = Date.now();
  let cleaned = 0;
  for (const [chatId, entry] of activeChatMap) {
    if (now - entry.lastActivityAt > STALE_THRESHOLD_MS) {
      activeChatMap.delete(chatId);
      cleaned++;
    }
  }
  if (cleaned > 0) {
    log.info({ cleaned }, "cleaned up stale telegram chat sessions");
  }
  return cleaned;
}
