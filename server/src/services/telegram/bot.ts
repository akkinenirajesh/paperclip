import { Bot } from "grammy";
import { logger } from "../../middleware/logger.js";

const log = logger.child({ service: "telegram" });

export function createBot(token: string): Bot {
  const bot = new Bot(token);

  bot.catch((err) => {
    log.error({ err: err.message ?? err }, "telegram bot unhandled error");
  });

  return bot;
}

export async function startPolling(bot: Bot): Promise<void> {
  log.info("starting telegram bot long polling...");
  await bot.start({
    onStart: (info) => {
      log.info({ username: info.username }, `telegram bot @${info.username} is running`);
    },
  });
}

export function stopBot(bot: Bot): void {
  try {
    bot.stop();
    log.info("telegram bot stopped");
  } catch {
    // bot may not have been started
  }
}

export { log as telegramLog };
