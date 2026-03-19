import { Bot } from "grammy";
import { config } from "./config.js";
import { migrate } from "./db.js";
import { registerHandlers } from "./message-handler.js";
import { startEventPoller } from "./event-poller.js";

async function main() {
  console.log("[telegram-bridge] starting...");

  // Run DB migrations
  await migrate();

  // Create the bot
  const bot = new Bot(config.telegramBotToken);

  // Global error handler — catch and log all errors
  bot.catch((err) => {
    console.error("[bot] unhandled error:", err.message ?? err);
    if (err.stack) console.error(err.stack);
  });

  // Register message handlers
  registerHandlers(bot);

  // Start event poller (Paperclip → Telegram notifications)
  const poller = startEventPoller(bot);

  // Graceful shutdown
  const shutdown = () => {
    console.log("[telegram-bridge] shutting down...");
    poller.stop();
    bot.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Start the bot (long polling)
  console.log("[telegram-bridge] bot starting with long polling...");
  await bot.start({
    onStart: (info) => {
      console.log(`[telegram-bridge] bot @${info.username} is running`);
    },
  });
}

main().catch((err) => {
  console.error("[telegram-bridge] fatal error:", err);
  process.exit(1);
});
