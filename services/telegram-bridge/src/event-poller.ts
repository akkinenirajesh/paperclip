import { Bot } from "grammy";
import { config } from "./config.js";
import * as db from "./db.js";
import { formatNotification } from "./ai.js";

/**
 * Polls Paperclip's database for new events (comments from agents, new approvals)
 * and forwards them to mapped Telegram users.
 */
const DIGEST_INTERVAL_MS = 8 * 60 * 60 * 1000; // 8 hours

export function startEventPoller(bot: Bot) {
  let running = true;

  async function poll() {
    while (running) {
      try {
        await pollAgentComments(bot);
        await pollApprovals(bot);
        await pollHumanAssignedIssues(bot);
      } catch (err) {
        console.error("[poller] error:", err);
      }
      await sleep(config.pollIntervalMs);
    }
  }

  async function digestLoop() {
    while (running) {
      await sleep(DIGEST_INTERVAL_MS);
      try {
        await pollTaskDigest(bot);
      } catch (err) {
        console.error("[poller] digest error:", err);
      }
    }
  }

  poll();
  digestLoop();

  return { stop: () => { running = false; } };
}

async function pollAgentComments(bot: Bot) {
  let cursor = await db.getCursor("last_comment_ts");
  if (!cursor) {
    // First run: set cursor to now so we don't notify for old comments
    cursor = new Date().toISOString();
    await db.setCursor("last_comment_ts", cursor);
    return;
  }
  const comments = await db.getNewIssueComments(cursor);

  if (comments.length === 0) return;

  const users = await db.getAllUsers();

  for (const comment of comments) {
    const recipients = users.filter(
      (u) => u.paperclip_company_id === comment.company_id || u.role === "board"
    );

    if (recipients.length === 0) continue;

    const agentName = await db.getAgentName(comment.author_agent_id!);
    const companyName = await db.getCompanyName(comment.company_id);
    const prefix = await db.getCompanyPrefix(comment.company_id);

    const isQuestion = comment.body.includes("?");
    const rawMessage = await formatNotification({
      type: "agent_comment",
      agentName,
      companyName,
      issueIdentifier: comment.issue_identifier,
      issueTitle: comment.issue_title,
      body: comment.body.slice(0, 1000),
      publicUrl: `${config.paperclipPublicUrl}/${prefix}/issues/${comment.issue_id}`,
    });
    const message = isQuestion
      ? `🔔 <b>ACTION NEEDED</b>\n\n${rawMessage}\n\n💬 <i>Reply to this message to answer</i>`
      : rawMessage;

    for (const recipient of recipients) {
      try {
        const sent = await bot.api.sendMessage(recipient.telegram_chat_id, message, {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
        });

        await db.saveMessageMap({
          telegram_chat_id: recipient.telegram_chat_id,
          telegram_message_id: String(sent.message_id),
          direction: "outbound",
          paperclip_issue_id: comment.issue_id,
          paperclip_comment_id: comment.id,
          paperclip_company_id: comment.company_id,
          raw_text: message,
        });
      } catch (err) {
        console.error(`[poller] failed to notify ${recipient.telegram_chat_id}:`, err);
      }
    }
  }

  // Advance cursor only after all sends complete
  const lastTs = new Date(new Date(comments[comments.length - 1].created_at).getTime() + 1);
  await db.setCursor("last_comment_ts", lastTs.toISOString());
}

async function pollApprovals(bot: Bot) {
  let cursor = await db.getCursor("last_approval_ts");
  if (!cursor) {
    cursor = new Date().toISOString();
    await db.setCursor("last_approval_ts", cursor);
    return;
  }
  const approvals = await db.getNewApprovals(cursor);

  if (approvals.length === 0) return;

  const users = await db.getAllUsers();
  const admins = users.filter((u) => u.role === "board");

  for (const approval of approvals) {
    const agentName = approval.requested_by_agent_id
      ? await db.getAgentName(approval.requested_by_agent_id)
      : "System";
    const companyName = await db.getCompanyName(approval.company_id);
    const payload = approval.payload as Record<string, unknown>;
    const title = (payload?.title as string) ?? (payload?.summary as string) ?? approval.type;
    const body = (payload?.body as string) ?? (payload?.description as string) ?? JSON.stringify(payload).slice(0, 300);

    const message = await formatNotification({
      type: "approval_needed",
      agentName,
      companyName,
      title,
      body,
      approvalId: approval.id,
      publicUrl: `${config.paperclipPublicUrl}/${await db.getCompanyPrefix(approval.company_id)}/approvals/${approval.id}`,
    });

    // Create short IDs for callback buttons (Telegram 64 byte limit)
    const shortCompany = approval.company_id.replace(/-/g, "").slice(0, 12);
    const shortApproval = approval.id.replace(/-/g, "").slice(0, 12);
    await db.saveCallbackMap(shortApproval, approval.company_id, approval.id);

    for (const member of admins) {
      try {
        const sent = await bot.api.sendMessage(member.telegram_chat_id, message, {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
          reply_markup: {
            inline_keyboard: [
              [
                { text: "✅ Approve", callback_data: `a:${shortCompany}:${shortApproval}` },
                { text: "❌ Reject", callback_data: `r:${shortCompany}:${shortApproval}` },
              ],
              [
                { text: "View in Paperclip", url: `${config.paperclipPublicUrl}/${await db.getCompanyPrefix(approval.company_id)}/approvals/${approval.id}` },
              ],
            ],
          },
        });

        await db.saveMessageMap({
          telegram_chat_id: member.telegram_chat_id,
          telegram_message_id: String(sent.message_id),
          direction: "outbound",
          paperclip_company_id: approval.company_id,
          raw_text: message,
        });
      } catch (err) {
        console.error(`[poller] failed to notify admin ${member.telegram_chat_id}:`, err);
      }
    }
  }

  // Advance cursor only after all sends complete
  const lastApprovalTs = new Date(new Date(approvals[approvals.length - 1].created_at).getTime() + 1);
  await db.setCursor("last_approval_ts", lastApprovalTs.toISOString());
}

async function pollTaskDigest(bot: Bot) {
  const users = await db.getAllUsers();
  const admins = users.filter((u) => u.role === "board");

  for (const admin of admins) {
    if (!admin.paperclip_company_id) continue;
    const companyId = admin.paperclip_company_id;

    const pendingApprovals = await db.getNewApprovals(
      new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
    );
    const unansweredQuestions = await db.getUnansweredAgentQuestions(companyId);

    const totalPending = pendingApprovals.length + unansweredQuestions.length;
    if (totalPending === 0) continue;

    const lines: string[] = [`📋 <b>Your pending tasks (${totalPending}):</b>\n`];
    let idx = 1;

    for (const a of pendingApprovals) {
      const payload = a.payload as Record<string, unknown>;
      const title = (payload?.title as string) ?? a.type;
      lines.push(`${idx}. ✅ <b>APPROVAL:</b> ${title}`);
      idx++;
    }

    for (const q of unansweredQuestions) {
      lines.push(`${idx}. ❓ <b>QUESTION</b> from ${q.agent_name} on ${q.issue_identifier}: "${q.body.slice(0, 80)}"`);
      idx++;
    }

    try {
      await bot.api.sendMessage(admin.telegram_chat_id, lines.join("\n"), {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
    } catch (err) {
      console.error(`[poller] failed to send digest to ${admin.telegram_chat_id}:`, err);
    }
  }
}

async function pollHumanAssignedIssues(bot: Bot) {
  let cursor = await db.getCursor("last_human_issue_ts");
  if (!cursor) {
    cursor = new Date().toISOString();
    await db.setCursor("last_human_issue_ts", cursor);
    return;
  }
  const issues = await db.getNewHumanAssignedIssues(cursor);

  if (issues.length === 0) return;

  for (const issue of issues) {
    const recipient = await db.getUserByPaperclipId(issue.assignee_user_id);
    if (!recipient) continue;

    const companyName = await db.getCompanyName(issue.company_id);
    const prefix = await db.getCompanyPrefix(issue.company_id);
    const url = `${config.paperclipPublicUrl}/${prefix}/issues/${issue.id}`;

    const message = await formatNotification({
      type: "issue_assigned",
      companyName,
      issueIdentifier: issue.identifier,
      issueTitle: issue.title,
      publicUrl: url,
    });

    try {
      const sent = await bot.api.sendMessage(recipient.telegram_chat_id, message, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });

      await db.saveMessageMap({
        telegram_chat_id: recipient.telegram_chat_id,
        telegram_message_id: String(sent.message_id),
        direction: "outbound",
        paperclip_issue_id: issue.id,
        paperclip_company_id: issue.company_id,
        raw_text: message,
      });
    } catch (err) {
      console.error(`[poller] failed to notify ${recipient.telegram_chat_id} for issue ${issue.identifier}:`, err);
    }
  }

  const lastTs = new Date(new Date(issues[issues.length - 1].created_at).getTime() + 1);
  await db.setCursor("last_human_issue_ts", lastTs.toISOString());
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
