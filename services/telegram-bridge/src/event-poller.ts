import { Bot } from "grammy";
import { config } from "./config.js";
import * as db from "./db.js";
import { formatNotification } from "./ai.js";

/**
 * Polls Paperclip's database for new events (comments from agents, new approvals)
 * and forwards them to mapped Telegram users.
 */
export function startEventPoller(bot: Bot) {
  let running = true;

  async function poll() {
    while (running) {
      try {
        await pollAgentComments(bot);
        await pollApprovals(bot);
      } catch (err) {
        console.error("[poller] error:", err);
      }
      await sleep(config.pollIntervalMs);
    }
  }

  poll();

  return { stop: () => { running = false; } };
}

async function pollAgentComments(bot: Bot) {
  const cursor = await db.getCursor("last_comment_ts") ?? new Date(Date.now() - 60_000).toISOString();
  const comments = await db.getNewIssueComments(cursor);

  if (comments.length === 0) return;

  const users = await db.getAllUsers();

  for (const comment of comments) {
    // Find telegram users mapped to this company
    const recipients = users.filter(
      (u) => u.paperclip_company_id === comment.company_id || u.role === "board"
    );

    if (recipients.length === 0) continue;

    // Check if we already notified for this comment (avoid duplicates)
    const agentName = await db.getAgentName(comment.author_agent_id!);
    const companyName = await db.getCompanyName(comment.company_id);

    const message = await formatNotification({
      type: "agent_comment",
      agentName,
      companyName,
      issueIdentifier: comment.issue_identifier,
      issueTitle: comment.issue_title,
      body: comment.body.slice(0, 300),
      publicUrl: `${config.paperclipPublicUrl}/companies/${comment.company_id}/issues/${comment.issue_id}`,
    });

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

  await db.setCursor("last_comment_ts", comments[comments.length - 1].created_at);
}

async function pollApprovals(bot: Bot) {
  const cursor = await db.getCursor("last_approval_ts") ?? new Date(Date.now() - 60_000).toISOString();
  const approvals = await db.getNewApprovals(cursor);

  if (approvals.length === 0) return;

  const users = await db.getAllUsers();
  // Only board members get approval notifications
  const boardMembers = users.filter((u) => u.role === "board");

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
      publicUrl: `${config.paperclipPublicUrl}/companies/${approval.company_id}/approvals/${approval.id}`,
    });

    for (const member of boardMembers) {
      try {
        const sent = await bot.api.sendMessage(member.telegram_chat_id, message, {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
          reply_markup: {
            inline_keyboard: [
              [
                { text: "Approve", callback_data: `approve:${approval.company_id}:${approval.id}` },
                { text: "Reject", callback_data: `reject:${approval.company_id}:${approval.id}` },
              ],
              [
                { text: "View in Paperclip", url: `${config.paperclipPublicUrl}/companies/${approval.company_id}/approvals/${approval.id}` },
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
        console.error(`[poller] failed to notify board member ${member.telegram_chat_id}:`, err);
      }
    }
  }

  await db.setCursor("last_approval_ts", approvals[approvals.length - 1].created_at);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
