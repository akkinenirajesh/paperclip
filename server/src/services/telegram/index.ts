import { createBot, startPolling, stopBot, telegramLog as log } from "./bot.js";
import { registerHandlers } from "./handlers.js";
import { startNotifications } from "./notifications.js";
import { stopAllStreaming } from "./streaming.js";
import { cleanupStaleSessions } from "./session-manager.js";
import type { TelegramService, TelegramServiceDeps } from "./types.js";

/**
 * Create the integrated Telegram service.
 *
 * Replaces the standalone telegram-bridge container.
 * Uses the server's shared DB, heartbeat service, and live events.
 * No OpenRouter / separate LLM — the agent itself handles all intelligence.
 */
export function createTelegramService(deps: TelegramServiceDeps): TelegramService {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    return {
      async start() {
        log.info("TELEGRAM_BOT_TOKEN not set — telegram service disabled");
      },
      stop() {},
    };
  }

  const bot = createBot(token);
  let notificationStopper: { stop: () => void } | null = null;
  let sessionCleanupTimer: ReturnType<typeof setInterval> | null = null;

  return {
    async start() {
      // Register message + command handlers
      registerHandlers(bot, deps);

      // Start notification service (live events + safety poll)
      notificationStopper = startNotifications(bot, deps.db, deps.publicUrl);

      // Periodic cleanup of stale session mappings (every 5 min)
      sessionCleanupTimer = setInterval(() => {
        cleanupStaleSessions();
      }, 5 * 60 * 1000);

      // Start long polling (non-blocking — runs in background)
      void startPolling(bot).catch((err) => {
        log.error({ err }, "telegram bot polling failed");
      });

      log.info("telegram service started");
    },

    stop() {
      log.info("stopping telegram service...");
      stopBot(bot);
      notificationStopper?.stop();
      stopAllStreaming();
      if (sessionCleanupTimer) clearInterval(sessionCleanupTimer);
      log.info("telegram service stopped");
    },
  };
}
