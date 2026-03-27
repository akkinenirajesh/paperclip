import type { Bot } from "grammy";
import type { LiveEvent } from "@paperclipai/shared";
import { subscribeCompanyLiveEvents } from "../live-events.js";
import { telegramLog as log } from "./bot.js";

/**
 * Watches active heartbeat runs and streams partial output to Telegram.
 *
 * Pattern (inspired by OpenClaw lane delivery):
 * 1. After invoke, track { chatId, runId, sentMessageId: null }
 * 2. Subscribe to live events for the company
 * 3. On run start → sendChatAction(chatId, 'typing')
 * 4. First stdout chunk → sendMessage → store message ID
 * 5. Subsequent chunks → editMessageText (throttled 300ms)
 * 6. On run finish → send final complete message
 * 7. Messages >4096 chars → split
 * 8. Convert markdown → Telegram HTML
 */

interface TrackedRun {
  chatId: string;
  companyId: string;
  agentId: string;
  sentMessageId: number | null;
  accumulated: string;
  lastEditAt: number;
  editTimer: ReturnType<typeof setTimeout> | null;
  finished: boolean;
}

const EDIT_THROTTLE_MS = 300;
const TELEGRAM_MAX_LENGTH = 4096;

const trackedRuns = new Map<string, TrackedRun>();
const companySubscriptions = new Map<string, () => void>();

/**
 * Start tracking a run for streaming to a Telegram chat.
 */
export function trackRun(
  bot: Bot,
  runId: string,
  chatId: string,
  companyId: string,
  agentId: string,
): void {
  trackedRuns.set(runId, {
    chatId,
    companyId,
    agentId,
    sentMessageId: null,
    accumulated: "",
    lastEditAt: 0,
    editTimer: null,
    finished: false,
  });

  // Send typing indicator
  bot.api.sendChatAction(Number(chatId), "typing").catch(() => {});

  // Ensure company subscription is active
  ensureCompanySubscription(bot, companyId);
}

function ensureCompanySubscription(bot: Bot, companyId: string): void {
  if (companySubscriptions.has(companyId)) return;

  const unsubscribe = subscribeCompanyLiveEvents(companyId, (event: LiveEvent) => {
    handleLiveEvent(bot, event);
  });

  companySubscriptions.set(companyId, unsubscribe);
}

function handleLiveEvent(bot: Bot, event: LiveEvent): void {
  const payload = event.payload as Record<string, unknown>;
  const runId = payload.runId as string | undefined;
  if (!runId) return;

  const tracked = trackedRuns.get(runId);
  if (!tracked) return;

  if (event.type === "heartbeat.run.log") {
    const stream = payload.stream as string;
    const chunk = payload.chunk as string;
    if (stream === "stdout" && chunk) {
      tracked.accumulated += chunk;
      scheduleEdit(bot, runId, tracked);
    }
  } else if (event.type === "heartbeat.run.status") {
    const status = payload.status as string;
    if (status === "completed" || status === "failed" || status === "cancelled") {
      tracked.finished = true;
      // Flush any pending edit
      if (tracked.editTimer) {
        clearTimeout(tracked.editTimer);
        tracked.editTimer = null;
      }
      flushToTelegram(bot, runId, tracked);
    }
  } else if (event.type === "heartbeat.run.event") {
    const eventType = payload.eventType as string;
    // Show tool use indicators
    if (eventType === "tool_use.start") {
      const toolName = (payload as any).toolName ?? "tool";
      bot.api.sendChatAction(Number(tracked.chatId), "typing").catch(() => {});
    }
  }
}

function scheduleEdit(bot: Bot, runId: string, tracked: TrackedRun): void {
  if (tracked.editTimer) return; // Already scheduled

  const elapsed = Date.now() - tracked.lastEditAt;
  const delay = Math.max(0, EDIT_THROTTLE_MS - elapsed);

  tracked.editTimer = setTimeout(() => {
    tracked.editTimer = null;
    flushToTelegram(bot, runId, tracked);
  }, delay);
}

async function flushToTelegram(bot: Bot, runId: string, tracked: TrackedRun): Promise<void> {
  if (!tracked.accumulated) return;

  const text = sanitizeForTelegram(tracked.accumulated);
  if (!text.trim()) return;

  try {
    if (!tracked.sentMessageId) {
      // First message — send new
      const truncated = text.length > TELEGRAM_MAX_LENGTH ? text.slice(0, TELEGRAM_MAX_LENGTH - 3) + "..." : text;
      const sent = await bot.api.sendMessage(Number(tracked.chatId), truncated, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
      tracked.sentMessageId = sent.message_id;
    } else {
      // Edit existing message
      const truncated = text.length > TELEGRAM_MAX_LENGTH ? text.slice(0, TELEGRAM_MAX_LENGTH - 3) + "..." : text;
      await bot.api.editMessageText(Number(tracked.chatId), tracked.sentMessageId, truncated, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
    }
    tracked.lastEditAt = Date.now();
  } catch (err: any) {
    // Telegram edit may fail if content hasn't changed, that's ok
    if (!err?.message?.includes("message is not modified")) {
      log.warn({ err: err.message, runId }, "failed to stream to telegram");
    }
  }

  // If finished and text is long, send remaining parts
  if (tracked.finished && text.length > TELEGRAM_MAX_LENGTH) {
    await sendLongMessage(bot, tracked.chatId, text);
    cleanup(runId);
    return;
  }

  if (tracked.finished) {
    cleanup(runId);
  }
}

/**
 * Split and send messages longer than Telegram's 4096 char limit.
 */
async function sendLongMessage(bot: Bot, chatId: string, text: string): Promise<void> {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= TELEGRAM_MAX_LENGTH) {
      chunks.push(remaining);
      break;
    }
    // Try to split at a newline
    let splitAt = remaining.lastIndexOf("\n", TELEGRAM_MAX_LENGTH);
    if (splitAt < TELEGRAM_MAX_LENGTH / 2) splitAt = TELEGRAM_MAX_LENGTH;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }
  // Skip first chunk (already sent as initial message), send rest
  for (let i = 1; i < chunks.length; i++) {
    try {
      await bot.api.sendMessage(Number(chatId), chunks[i], {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
    } catch (err: any) {
      log.warn({ err: err.message }, "failed to send long message chunk");
    }
  }
}

function cleanup(runId: string): void {
  const tracked = trackedRuns.get(runId);
  if (tracked?.editTimer) {
    clearTimeout(tracked.editTimer);
  }
  trackedRuns.delete(runId);
}

/**
 * Basic markdown → Telegram HTML conversion.
 * Telegram supports: <b>, <i>, <code>, <pre>, <a>.
 */
function sanitizeForTelegram(text: string): string {
  return text
    // Escape HTML entities first
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    // Bold: **text** → <b>text</b>
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    // Italic: *text* → <i>text</i>
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<i>$1</i>")
    // Code blocks: ```text``` → <pre>text</pre>
    .replace(/```[\w]*\n?([\s\S]*?)```/g, "<pre>$1</pre>")
    // Inline code: `text` → <code>text</code>
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

/**
 * Stop all active tracking and subscriptions.
 */
export function stopAllStreaming(): void {
  for (const [runId, tracked] of trackedRuns) {
    if (tracked.editTimer) clearTimeout(tracked.editTimer);
  }
  trackedRuns.clear();
  for (const [, unsubscribe] of companySubscriptions) {
    unsubscribe();
  }
  companySubscriptions.clear();
}
