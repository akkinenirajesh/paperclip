import { Bot } from "grammy";
import { config } from "./config.js";
import * as db from "./db.js";
import * as paperclip from "./paperclip-api.js";
import { classifyMessage, generateReply } from "./ai.js";

/**
 * Register all Telegram message and callback handlers on the bot.
 *
 * Whitelisting model:
 *  - First user to /start becomes board admin (bootstrap)
 *  - Only board members can /whitelist other users
 *  - Unwhitelisted users get a "not authorized" message with their chat ID
 *  - All privileged commands require whitelisted status
 */
export function registerHandlers(bot: Bot) {

  /** Try to auto-link a user to a company if there's only one. */
  async function tryAutoLink(chatId: string): Promise<string | null> {
    const user = await db.getUser(chatId);
    if (user?.paperclip_company_id) return user.paperclip_company_id;
    try {
      const companies = await db.listCompanies();
      if (companies.length === 1) {
        await db.upsertUser({ telegram_chat_id: chatId, paperclip_company_id: companies[0].id });
        return companies[0].id;
      }
    } catch { /* API may not be ready */ }
    return null;
  }

  // --- /start command ---
  bot.command("start", async (ctx) => {
    const chatId = String(ctx.chat.id);
    const username = ctx.from?.username ?? null;
    const displayName = [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(" ") || username;

    const existing = await db.getUser(chatId);
    if (existing) {
      await tryAutoLink(chatId);
      await ctx.reply(
        `Welcome back, ${displayName}! You're connected as <b>${existing.role}</b>.\n\nSend a message to interact with the AI team.`,
        { parse_mode: "HTML" }
      );
      return;
    }

    // Check if any users exist — first user becomes board admin
    const allUsers = await db.getAllUsers();
    if (allUsers.length === 0) {
      await db.upsertUser({
        telegram_chat_id: chatId,
        telegram_username: username,
        telegram_display_name: displayName,
        role: "board",
      });
      // Auto-link if only one company
      const companyId = await tryAutoLink(chatId);
      const linkMsg = companyId
        ? `\n\nAuto-linked to your company.`
        : `\n\nUse /companies then /link &lt;company_id&gt; to connect.`;
      await ctx.reply(
        `🎉 <b>You are the first user — registered as board admin!</b>${linkMsg}\n\n` +
        `To add team members, have them message this bot, then use:\n` +
        `<code>/whitelist &lt;chat_id&gt; &lt;role&gt;</code>\n\n` +
        `Roles: <b>board</b> (approvals + all notifications) or <b>member</b> (company notifications)`,
        { parse_mode: "HTML" }
      );
      return;
    }

    // Not the first user — show chat ID and ask them to get whitelisted
    await ctx.reply(
      `Hi ${displayName}! This bot is restricted.\n\n` +
      `Ask your board admin to whitelist you with:\n` +
      `<code>/whitelist ${chatId} member</code>\n\n` +
      `Your chat ID: <code>${chatId}</code>`,
      { parse_mode: "HTML" }
    );
  });

  // --- /whitelist command: board-only, add a user ---
  bot.command("whitelist", async (ctx) => {
    const caller = await db.getUser(String(ctx.chat.id));
    if (!caller || caller.role !== "board") {
      await ctx.reply("⛔ Only board members can whitelist users.");
      return;
    }

    const args = (ctx.match ?? "").trim().split(/\s+/);
    const targetChatId = args[0];
    const role = args[1] ?? "member";

    if (!targetChatId || !["board", "member"].includes(role)) {
      await ctx.reply("Usage: <code>/whitelist &lt;chat_id&gt; &lt;role&gt;</code>\nRoles: board, member", { parse_mode: "HTML" });
      return;
    }

    await db.upsertUser({
      telegram_chat_id: targetChatId,
      role,
    });
    await ctx.reply(`✅ User <code>${targetChatId}</code> whitelisted as <b>${role}</b>`, { parse_mode: "HTML" });

    // Notify the whitelisted user
    try {
      await bot.api.sendMessage(
        targetChatId,
        `🎉 You've been whitelisted as <b>${role}</b>! Send /start to get started.`,
        { parse_mode: "HTML" }
      );
    } catch { /* user may not have messaged bot yet */ }
  });

  // --- /revoke command: board-only, remove a user ---
  bot.command("revoke", async (ctx) => {
    const caller = await db.getUser(String(ctx.chat.id));
    if (!caller || caller.role !== "board") {
      await ctx.reply("⛔ Only board members can revoke users.");
      return;
    }

    const targetChatId = (ctx.match ?? "").trim();
    if (!targetChatId) {
      await ctx.reply("Usage: <code>/revoke &lt;chat_id&gt;</code>", { parse_mode: "HTML" });
      return;
    }

    await db.deleteUser(targetChatId);
    await ctx.reply(`✅ User <code>${targetChatId}</code> removed.`, { parse_mode: "HTML" });
  });

  // --- /members command: board-only, list whitelisted users ---
  bot.command("members", async (ctx) => {
    const caller = await db.getUser(String(ctx.chat.id));
    if (!caller || caller.role !== "board") {
      await ctx.reply("⛔ Only board members can view members.");
      return;
    }

    const users = await db.getAllUsers();
    if (users.length === 0) {
      await ctx.reply("No members registered.");
      return;
    }

    const lines = users.map((u) =>
      `• <b>${u.telegram_display_name ?? u.telegram_username ?? "Unknown"}</b> ` +
      `(<code>${u.telegram_chat_id}</code>) — ${u.role}` +
      (u.paperclip_company_id ? ` — linked` : ` — unlinked`)
    );
    await ctx.reply(`<b>Members</b>\n\n${lines.join("\n")}`, { parse_mode: "HTML" });
  });

  // --- Middleware: check whitelist for all subsequent handlers ---
  function isWhitelisted(chatId: string): Promise<db.TelegramUser | null> {
    return db.getUser(chatId);
  }

  // --- /status command ---
  bot.command("status", async (ctx) => {
    if (!await isWhitelisted(String(ctx.chat.id))) {
      await ctx.reply("⛔ You're not authorized. Ask a board admin to /whitelist you.");
      return;
    }
    try {
      const health = await paperclip.healthCheck();
      await ctx.reply(
        `<b>Paperclip Status</b>\nStatus: ${health.status}\nURL: ${config.paperclipPublicUrl}`,
        { parse_mode: "HTML" }
      );
    } catch {
      await ctx.reply("⚠️ Could not reach Paperclip server.");
    }
  });

  // --- /companies command ---
  bot.command("companies", async (ctx) => {
    if (!await isWhitelisted(String(ctx.chat.id))) {
      await ctx.reply("⛔ You're not authorized.");
      return;
    }
    try {
      const companies = await db.listCompanies();
      if (companies.length === 0) {
        await ctx.reply("No companies found. Create one in the Paperclip UI first.");
        return;
      }
      const lines = companies.map((c) => `• <b>${c.name}</b>\n  <code>${c.id}</code>`);
      await ctx.reply(`<b>Companies</b>\n\n${lines.join("\n\n")}`, { parse_mode: "HTML" });
    } catch {
      await ctx.reply("⚠️ Could not fetch companies.");
    }
  });

  // --- /link command ---
  bot.command("link", async (ctx) => {
    const user = await isWhitelisted(String(ctx.chat.id));
    if (!user) {
      await ctx.reply("⛔ You're not authorized.");
      return;
    }
    const companyId = (ctx.match ?? "").trim();
    if (!companyId) {
      await ctx.reply("Usage: <code>/link &lt;company_id&gt;</code>", { parse_mode: "HTML" });
      return;
    }
    await db.upsertUser({
      telegram_chat_id: String(ctx.chat.id),
      paperclip_company_id: companyId,
    });
    await ctx.reply(`✅ Linked to company <code>${companyId}</code>`, { parse_mode: "HTML" });
  });

  // --- Inline button callbacks (approvals) ---
  bot.on("callback_query:data", async (ctx) => {
    const user = await isWhitelisted(String(ctx.from.id));
    if (!user || user.role !== "board") {
      await ctx.answerCallbackQuery({ text: "⛔ Only board members can act on approvals" });
      return;
    }

    const data = ctx.callbackQuery.data;
    const [action, , shortApprovalId] = data.split(":");

    if (!shortApprovalId) {
      await ctx.answerCallbackQuery({ text: "Invalid action" });
      return;
    }

    // Resolve short ID to full UUIDs
    const mapping = await db.getCallbackMap(shortApprovalId);
    if (!mapping) {
      await ctx.answerCallbackQuery({ text: "Approval not found — it may have expired" });
      return;
    }

    try {
      if (action === "a") {
        await db.approveApproval(mapping.approval_id, "board");
        await ctx.answerCallbackQuery({ text: "✅ Approved!" });
        await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });
        await ctx.reply("✅ Approval granted. Agent has been notified.");
      } else if (action === "r") {
        await db.rejectApproval(mapping.approval_id, "board");
        await ctx.answerCallbackQuery({ text: "❌ Rejected" });
        await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });
        await ctx.reply("❌ Approval rejected.");
      }
    } catch (err) {
      console.error("[callback] approval action failed:", err);
      await ctx.answerCallbackQuery({ text: "Failed — try via the web UI" });
    }
  });

  // --- General text messages: AI-powered routing ---
  bot.on("message:text", async (ctx) => {
    const chatId = String(ctx.chat.id);
    const messageText = ctx.message.text;

    let user = await isWhitelisted(chatId);
    if (!user) {
      await ctx.reply(
        `⛔ You're not authorized.\n\nYour chat ID: <code>${chatId}</code>\nAsk a board admin to whitelist you.`,
        { parse_mode: "HTML" }
      );
      return;
    }

    if (!user.paperclip_company_id) {
      const linked = await tryAutoLink(chatId);
      if (linked) {
        user = (await db.getUser(chatId))!;
      } else {
        await ctx.reply(
          "You're not linked to a company yet.\nUse /companies to list them, then /link <company_id>."
        );
        return;
      }
    }
    const companyId = user.paperclip_company_id!;
    const companyPrefix = await db.getCompanyPrefix(companyId);

    // Save inbound message
    await db.saveMessageMap({
      telegram_chat_id: chatId,
      telegram_message_id: String(ctx.message.message_id),
      direction: "inbound",
      paperclip_company_id: companyId,
      raw_text: messageText,
    });

    // Get chat context for AI classification
    const chatContext = await db.getRecentChatContext(chatId);

    // Get pending approvals for this company
    let pendingApprovals: Array<{ id: string; title: string }> = [];
    try {
      pendingApprovals = (await db.getNewApprovals(
        new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
      )).map((a) => ({
        id: a.id,
        title: (a.payload as Record<string, unknown>)?.title as string ?? a.type,
      }));
    } catch { /* ignore */ }

    // Show typing indicator while processing
    await ctx.api.sendChatAction(ctx.chat.id, "typing");
    const typingInterval = setInterval(() => {
      ctx.api.sendChatAction(ctx.chat.id, "typing").catch(() => {});
    }, 4000);

    // Get available agents for routing
    const availableAgents = await db.listAgents(companyId);

    // Classify the message with AI
    console.log(`[handler] classifying message from ${chatId}: "${messageText.slice(0, 80)}"`);
    const classification = await classifyMessage(messageText, chatContext, pendingApprovals, availableAgents);
    console.log(`[handler] classification:`, JSON.stringify(classification));

    let reply: string;

    switch (classification.intent) {
      case "new_issue": {
        try {
          const issue = await db.createIssue(companyId, {
            title: classification.title ?? messageText.slice(0, 100),
            description: classification.body,
            assigneeAgentId: classification.assignTo,
          });
          reply = `📋 Created issue <b>${issue.identifier}</b>: ${issue.title}\n\n` +
            `<a href="${config.paperclipPublicUrl}/${companyPrefix}/issues/${issue.id}">View in Paperclip</a>`;

          await db.saveMessageMap({
            telegram_chat_id: chatId,
            telegram_message_id: String(ctx.message.message_id),
            direction: "inbound",
            paperclip_issue_id: issue.id,
            paperclip_company_id: companyId,
            raw_text: messageText,
          });

          // Trigger agent heartbeat so an agent picks up the new issue
          await db.triggerHeartbeat(companyId);
        } catch (err) {
          console.error("[handler] create issue failed:", err);
          reply = "⚠️ Failed to create issue. Please try again or use the web UI.";
        }
        break;
      }

      case "reply_to_issue": {
        if (!classification.issueId) {
          reply = "I couldn't determine which issue you're replying to. Could you be more specific?";
          break;
        }
        try {
          await db.createIssueComment(companyId, classification.issueId, classification.body);
          // Reassign if the AI suggests a different agent
          let assignMsg = "";
          if (classification.assignTo) {
            await db.updateIssueAssignment(classification.issueId, classification.assignTo);
            const agentName = await db.getAgentName(classification.assignTo);
            assignMsg = `\n🔄 Reassigned to <b>${agentName}</b>`;
          }
          reply = `💬 Comment added to issue.${assignMsg}\n\n` +
            `<a href="${config.paperclipPublicUrl}/${companyPrefix}/issues/${classification.issueId}">View thread</a>`;

          await db.saveMessageMap({
            telegram_chat_id: chatId,
            telegram_message_id: String(ctx.message.message_id),
            direction: "inbound",
            paperclip_issue_id: classification.issueId,
            paperclip_company_id: companyId,
            raw_text: messageText,
          });

          // Trigger heartbeat for the updated issue
          await db.triggerHeartbeat(companyId);
        } catch (err) {
          console.error("[handler] create comment failed:", err);
          reply = "⚠️ Failed to add comment. Please try again.";
        }
        break;
      }

      case "approval_response": {
        if (!classification.approvalId || !classification.approvalAction) {
          reply = "I couldn't determine which approval you're responding to. Use the buttons on the approval message.";
          break;
        }
        if (user.role !== "board") {
          reply = "⛔ Only board members can act on approvals.";
          break;
        }
        try {
          if (classification.approvalAction === "approve") {
            await paperclip.approveApproval(companyId, classification.approvalId);
            reply = "✅ Approved!";
          } else if (classification.approvalAction === "reject") {
            await paperclip.rejectApproval(companyId, classification.approvalId);
            reply = "❌ Rejected.";
          } else {
            reply = "Revision requested — please add details in the web UI.";
          }
        } catch (err) {
          console.error("[handler] approval action failed:", err);
          reply = "⚠️ Failed to process approval. Try via the web UI.";
        }
        break;
      }

      case "status_query": {
        try {
          // Check if there's an active issue with pending agent questions
          const lastIssueMsg = chatContext.slice(-10).reverse().find((m) => m.paperclip_issue_id);
          if (lastIssueMsg?.paperclip_issue_id) {
            const agentComment = await db.getLatestAgentComment(lastIssueMsg.paperclip_issue_id);
            if (agentComment) {
              const issueTitle = await db.getIssueTitle(lastIssueMsg.paperclip_issue_id);
              reply = `📋 <b>${issueTitle}</b>\n\n` +
                `<b>${agentComment.agent_name}</b> is waiting for your input:\n\n` +
                `${agentComment.body.slice(0, 1500)}\n\n` +
                `💬 <b>Reply here to respond to ${agentComment.agent_name}</b>`;
              break;
            }
          }

          // Fallback: general status
          const issues = await db.listRecentIssues(companyId);
          const agents = await db.listAgents(companyId);

          const companyContext = [
            `Active agents: ${agents.filter((a) => a.status === "active").length}/${agents.length}`,
            `Recent issues: ${issues.length}`,
            issues.slice(0, 5).map((i) => `• [${i.identifier}] ${i.title} (${i.status})`).join("\n"),
          ].join("\n");

          reply = await generateReply(messageText, chatContext, companyContext);
        } catch {
          reply = "⚠️ Couldn't fetch status. The Paperclip server may be busy.";
        }
        break;
      }

      default: {
        reply = await generateReply(messageText, chatContext, "General conversation with board/team member.");
        break;
      }
    }

    clearInterval(typingInterval);

    const sent = await ctx.reply(reply, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });

    await db.saveMessageMap({
      telegram_chat_id: chatId,
      telegram_message_id: String(sent.message_id),
      direction: "outbound",
      paperclip_company_id: companyId,
      raw_text: reply,
    });
  });
}
