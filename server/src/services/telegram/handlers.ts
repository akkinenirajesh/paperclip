import type { Bot } from "grammy";
import * as q from "./queries.js";
import { telegramLog as log } from "./bot.js";
import { runTelegramAgent, type MessageMeta } from "./agent.js";
import type { TelegramServiceDeps } from "./types.js";

/**
 * Register all Telegram command and text handlers on the bot.
 *
 * Every text message is passed to the AI agent (Claude via Anthropic API)
 * with tools and chat history. The agent decides what to do:
 *  - Reply conversationally
 *  - Create issues
 *  - Add comments to existing issues
 *  - Wake company agents
 *  - Or any combination
 */
export function registerHandlers(bot: Bot, deps: TelegramServiceDeps) {
  const { db, heartbeatService: heartbeat, publicUrl } = deps;

  async function tryAutoLink(chatId: string): Promise<string | null> {
    const user = await q.getUser(db, chatId);
    if (user?.paperclipCompanyId) return user.paperclipCompanyId;
    try {
      const companies = await q.listCompanies(db);
      if (companies.length === 1) {
        await q.upsertUser(db, {
          telegramChatId: chatId,
          paperclipCompanyId: companies[0].id,
        });
        return companies[0].id;
      }
    } catch {
      /* server may not be ready */
    }
    return null;
  }

  // ── /start ──
  bot.command("start", async (ctx) => {
    const chatId = String(ctx.chat.id);
    const username = ctx.from?.username ?? null;
    const displayName =
      [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(" ") || username;

    const existing = await q.getUser(db, chatId);
    if (existing) {
      await tryAutoLink(chatId);
      await ctx.reply(
        `Welcome back, ${displayName}! You're connected as <b>${existing.role}</b>.\n\nSend a message to interact with the AI team.`,
        { parse_mode: "HTML" },
      );
      return;
    }

    // First user becomes admin
    const allUsers = await q.getAllUsers(db);
    if (allUsers.length === 0) {
      await q.upsertUser(db, {
        telegramChatId: chatId,
        telegramUsername: username,
        telegramDisplayName: displayName,
        role: "board",
      });
      const companyId = await tryAutoLink(chatId);
      const linkMsg = companyId
        ? `\n\nAuto-linked to your company.`
        : `\n\nUse /companies then /link &lt;company_id&gt; to connect.`;
      await ctx.reply(
        `<b>You are the first user — registered as admin!</b>${linkMsg}\n\n` +
          `To add team members, have them message this bot, then use:\n` +
          `<code>/whitelist &lt;chat_id&gt; &lt;role&gt;</code>\n\n` +
          `Roles: <b>board</b> (admin — approvals + all notifications) or <b>member</b> (company notifications)`,
        { parse_mode: "HTML" },
      );
      return;
    }

    await ctx.reply(
      `Hi ${displayName}! This bot is restricted.\n\n` +
        `Ask your admin to whitelist you with:\n` +
        `<code>/whitelist ${chatId} member</code>\n\n` +
        `Your chat ID: <code>${chatId}</code>`,
      { parse_mode: "HTML" },
    );
  });

  // ── /whitelist ──
  bot.command("whitelist", async (ctx) => {
    const caller = await q.getUser(db, String(ctx.chat.id));
    if (!caller || caller.role !== "board") {
      await ctx.reply("Only admins can whitelist users.");
      return;
    }
    const args = (ctx.match ?? "").trim().split(/\s+/);
    const targetChatId = args[0];
    const role = args[1] ?? "member";
    if (!targetChatId || !["board", "member"].includes(role)) {
      await ctx.reply(
        "Usage: <code>/whitelist &lt;chat_id&gt; &lt;role&gt;</code>\nRoles: board, member",
        { parse_mode: "HTML" },
      );
      return;
    }
    await q.upsertUser(db, { telegramChatId: targetChatId, role });
    await ctx.reply(
      `User <code>${targetChatId}</code> whitelisted as <b>${role}</b>`,
      { parse_mode: "HTML" },
    );
    try {
      await bot.api.sendMessage(
        targetChatId,
        `You've been whitelisted as <b>${role}</b>! Send /start to get started.`,
        { parse_mode: "HTML" },
      );
    } catch {
      /* user may not have messaged bot yet */
    }
  });

  // ── /revoke ──
  bot.command("revoke", async (ctx) => {
    const caller = await q.getUser(db, String(ctx.chat.id));
    if (!caller || caller.role !== "board") {
      await ctx.reply("Only admins can revoke users.");
      return;
    }
    const targetChatId = (ctx.match ?? "").trim();
    if (!targetChatId) {
      await ctx.reply("Usage: <code>/revoke &lt;chat_id&gt;</code>", { parse_mode: "HTML" });
      return;
    }
    await q.deleteUser(db, targetChatId);
    await ctx.reply(`User <code>${targetChatId}</code> removed.`, { parse_mode: "HTML" });
  });

  // ── /members ──
  bot.command("members", async (ctx) => {
    const caller = await q.getUser(db, String(ctx.chat.id));
    if (!caller || caller.role !== "board") {
      await ctx.reply("Only admins can view members.");
      return;
    }
    const users = await q.getAllUsers(db);
    if (users.length === 0) {
      await ctx.reply("No members registered.");
      return;
    }
    const lines = users.map(
      (u) =>
        `- <b>${u.telegramDisplayName ?? u.telegramUsername ?? "Unknown"}</b> ` +
        `(<code>${u.telegramChatId}</code>) — ${u.role}` +
        (u.paperclipCompanyId ? ` — linked` : ` — unlinked`),
    );
    await ctx.reply(`<b>Members</b>\n\n${lines.join("\n")}`, { parse_mode: "HTML" });
  });

  // ── /tasks ──
  bot.command("tasks", async (ctx) => {
    const user = await q.getUser(db, String(ctx.chat.id));
    if (!user) {
      await ctx.reply("You're not authorized. Ask an admin to /whitelist you.");
      return;
    }
    const companyId = user.paperclipCompanyId ?? (await tryAutoLink(String(ctx.chat.id)));
    if (!companyId) {
      await ctx.reply("You're not linked to a company yet. Use /companies then /link <company_id>.");
      return;
    }
    const pendingApprovals = await q.getNewApprovals(
      db,
      new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
    );
    const unansweredQuestions = await q.getUnansweredAgentQuestions(db, companyId);
    const totalPending = pendingApprovals.length + unansweredQuestions.length;
    if (totalPending === 0) {
      await ctx.reply("No pending tasks — you're all caught up!");
      return;
    }
    const lines: string[] = [`<b>Your pending tasks (${totalPending}):</b>\n`];
    let idx = 1;
    for (const a of pendingApprovals) {
      const payload = a.payload as Record<string, unknown>;
      const title = (payload?.title as string) ?? a.type;
      lines.push(`${idx}. <b>APPROVAL:</b> ${title}`);
      idx++;
    }
    for (const uq of unansweredQuestions) {
      lines.push(
        `${idx}. <b>QUESTION</b> from ${uq.agentName} on ${uq.issueIdentifier}: "${(uq.body as string).slice(0, 80)}"`,
      );
      idx++;
    }
    await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
  });

  // ── /status ──
  bot.command("status", async (ctx) => {
    const user = await q.getUser(db, String(ctx.chat.id));
    if (!user) {
      await ctx.reply("You're not authorized. Ask an admin to /whitelist you.");
      return;
    }
    await ctx.reply(
      `<b>Paperclip Status</b>\nServer: running\nURL: ${publicUrl}`,
      { parse_mode: "HTML" },
    );
  });

  // ── /companies ──
  bot.command("companies", async (ctx) => {
    const user = await q.getUser(db, String(ctx.chat.id));
    if (!user) {
      await ctx.reply("You're not authorized.");
      return;
    }
    const companies = await q.listCompanies(db);
    if (companies.length === 0) {
      await ctx.reply("No companies found. Create one in the Paperclip UI first.");
      return;
    }
    const lines = companies.map((c) => `- <b>${c.name}</b>\n  <code>${c.id}</code>`);
    await ctx.reply(`<b>Companies</b>\n\n${lines.join("\n\n")}`, { parse_mode: "HTML" });
  });

  // ── /link ──
  bot.command("link", async (ctx) => {
    const user = await q.getUser(db, String(ctx.chat.id));
    if (!user) {
      await ctx.reply("You're not authorized.");
      return;
    }
    const companyId = (ctx.match ?? "").trim();
    if (!companyId) {
      await ctx.reply("Usage: <code>/link &lt;company_id&gt;</code>", { parse_mode: "HTML" });
      return;
    }
    await q.upsertUser(db, {
      telegramChatId: String(ctx.chat.id),
      paperclipCompanyId: companyId,
    });
    await ctx.reply(`Linked to company <code>${companyId}</code>`, { parse_mode: "HTML" });
  });

  // ── Callback query (approval buttons) ──
  bot.on("callback_query:data", async (ctx) => {
    const user = await q.getUser(db, String(ctx.from.id));
    if (!user || user.role !== "board") {
      await ctx.answerCallbackQuery({ text: "Only admins can act on approvals" });
      return;
    }
    const data = ctx.callbackQuery.data;
    const [action, , shortApprovalId] = data.split(":");
    if (!shortApprovalId) {
      await ctx.answerCallbackQuery({ text: "Invalid action" });
      return;
    }
    const mapping = await q.getCallbackMap(db, shortApprovalId);
    if (!mapping) {
      await ctx.answerCallbackQuery({ text: "Approval not found — it may have expired" });
      return;
    }
    try {
      if (action === "a") {
        const requestingAgentId = await q.approveApproval(db, mapping.approvalId, "board");
        await ctx.answerCallbackQuery({ text: "Approved!" });
        await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });
        await ctx.reply("Approval granted. Agent has been notified.");
        // Wake the requesting agent via heartbeat
        if (requestingAgentId) {
          await heartbeat.wakeup(requestingAgentId, {
            source: "on_demand",
            triggerDetail: "callback",
            reason: "approval_approved",
            requestedByActorType: "user" as const,
            requestedByActorId: "telegram-board",
          });
        }
      } else if (action === "r") {
        await q.rejectApproval(db, mapping.approvalId, "board");
        await ctx.answerCallbackQuery({ text: "Rejected" });
        await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });
        await ctx.reply("Approval rejected.");
      }
    } catch (err) {
      log.error({ err }, "approval callback action failed");
      await ctx.answerCallbackQuery({ text: "Failed — try via the web UI" });
    }
  });

  // ── General text messages — all go through AI agent ──
  bot.on("message:text", async (ctx) => {
    const chatId = String(ctx.chat.id);
    const messageText = ctx.message.text;

    let user = await q.getUser(db, chatId);
    if (!user) {
      await ctx.reply(
        `You're not authorized.\n\nYour chat ID: <code>${chatId}</code>\nAsk an admin to whitelist you.`,
        { parse_mode: "HTML" },
      );
      return;
    }

    if (!user.paperclipCompanyId) {
      const linked = await tryAutoLink(chatId);
      if (linked) {
        user = (await q.getUser(db, chatId))!;
      } else {
        await ctx.reply(
          "You're not linked to a company yet.\nUse /companies to list them, then /link <company_id>.",
        );
        return;
      }
    }
    const companyId = user.paperclipCompanyId!;

    // Save inbound message
    await q.saveMessageMap(db, {
      telegramChatId: chatId,
      telegramMessageId: String(ctx.message.message_id),
      direction: "inbound",
      paperclipCompanyId: companyId,
      rawText: messageText,
    });

    // Show typing while agent thinks
    await ctx.api.sendChatAction(ctx.chat.id, "typing");
    const typingInterval = setInterval(() => {
      ctx.api.sendChatAction(ctx.chat.id, "typing").catch(() => {});
    }, 4000);

    try {
      // Get recent chat context for the agent
      const recentContext = await q.getRecentChatContext(db, chatId);

      // Build reply metadata
      const replyToMsg = ctx.message.reply_to_message;
      let replyMeta: { issueId?: string; originalText?: string } | null = null;
      if (replyToMsg) {
        const mapped = await q.getMessageMapByTelegramId(db, chatId, String(replyToMsg.message_id));
        replyMeta = {
          issueId: mapped?.paperclipIssueId ?? undefined,
          originalText: ("text" in replyToMsg && replyToMsg.text) ? replyToMsg.text.slice(0, 500) : undefined,
        };
      }

      // Build message metadata — always passed to agent, even on resume
      const messageMeta = {
        chatId,
        senderName: [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(" ") || ctx.from?.username || "Unknown",
        isReply: !!replyToMsg,
        replyTo: replyMeta,
        timestamp: new Date().toISOString(),
      };

      // Run the AI agent — it decides what to do
      const result = await runTelegramAgent(deps, chatId, companyId, messageText, recentContext, messageMeta);

      clearInterval(typingInterval);

      // Send the agent's reply
      if (result.reply) {
        const sent = await ctx.reply(result.reply, {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
        });

        await q.saveMessageMap(db, {
          telegramChatId: chatId,
          telegramMessageId: String(sent.message_id),
          direction: "outbound",
          paperclipCompanyId: companyId,
          paperclipIssueId: result.createdIssueId ?? undefined,
          rawText: result.reply,
        });
      }
    } catch (err) {
      clearInterval(typingInterval);
      log.error({ err }, "telegram agent failed");
      await ctx.reply("Something went wrong. Please try again.");
    }
  });
}
