import type { Bot } from "grammy";
import type { LiveEvent } from "@paperclipai/shared";
import { subscribeCompanyLiveEvents, subscribeGlobalLiveEvents } from "../live-events.js";
import * as q from "./queries.js";
import { telegramLog as log } from "./bot.js";

const DIGEST_INTERVAL_MS = 8 * 60 * 60 * 1000; // 8 hours
const SAFETY_POLL_INTERVAL_MS = 60 * 1000; // 60s safety-net poll

interface NotificationServiceState {
  companyUnsubscribers: Map<string, () => void>;
  globalUnsubscribe: (() => void) | null;
  safetyPollTimer: ReturnType<typeof setInterval> | null;
  digestTimer: ReturnType<typeof setInterval> | null;
  running: boolean;
}

/**
 * Start the notification service.
 * Uses live event subscriptions for real-time notifications,
 * with a safety-net poll for anything that might be missed.
 */
export function startNotifications(
  bot: Bot,
  db: any,
  publicUrl: string,
): { stop: () => void } {
  const state: NotificationServiceState = {
    companyUnsubscribers: new Map(),
    globalUnsubscribe: null,
    safetyPollTimer: null,
    digestTimer: null,
    running: true,
  };

  // Subscribe to global events to detect new companies
  state.globalUnsubscribe = subscribeGlobalLiveEvents((event) => {
    // When a new company is created, subscribe to its events
    if (event.type === "heartbeat.run.status" && event.companyId !== "*") {
      ensureCompanySubscription(event.companyId);
    }
  });

  // Subscribe to known companies
  void initCompanySubscriptions();

  // Safety-net poll (60s)
  state.safetyPollTimer = setInterval(() => {
    if (!state.running) return;
    void safetyPoll().catch((err) => {
      log.error({ err }, "notification safety poll failed");
    });
  }, SAFETY_POLL_INTERVAL_MS);

  // Digest loop (8h)
  state.digestTimer = setInterval(() => {
    if (!state.running) return;
    void sendDigest().catch((err) => {
      log.error({ err }, "notification digest failed");
    });
  }, DIGEST_INTERVAL_MS);

  async function initCompanySubscriptions() {
    try {
      const companies = await q.listCompanies(db);
      for (const company of companies) {
        ensureCompanySubscription(company.id);
      }
    } catch (err) {
      log.error({ err }, "failed to init company subscriptions for notifications");
    }
  }

  function ensureCompanySubscription(companyId: string) {
    if (state.companyUnsubscribers.has(companyId)) return;
    const unsub = subscribeCompanyLiveEvents(companyId, (event) => {
      void handleCompanyEvent(companyId, event).catch((err) => {
        log.error({ err, companyId, eventType: event.type }, "failed to handle live event notification");
      });
    });
    state.companyUnsubscribers.set(companyId, unsub);
  }

  async function handleCompanyEvent(companyId: string, event: LiveEvent) {
    const payload = event.payload as Record<string, unknown>;

    // Agent comment completed → notify linked users
    if (event.type === "heartbeat.run.status" && payload.status === "completed") {
      // The run completed — check for new agent comments via safety poll
      // (The safety poll will pick up any new comments within 60s)
      return;
    }

    // For real-time: we could also listen to activity.logged events
    // but safety poll handles this reliably
  }

  async function safetyPoll() {
    try {
      await pollAgentComments();
      await pollApprovals();
      await pollHumanAssignedIssues();
    } catch (err) {
      log.error({ err }, "safety poll error");
    }
  }

  async function pollAgentComments() {
    let cursor = await q.getCursor(db, "last_comment_ts");
    if (!cursor) {
      cursor = new Date().toISOString();
      await q.setCursor(db, "last_comment_ts", cursor);
      return;
    }
    const comments = await q.getNewIssueComments(db, cursor);
    if (comments.length === 0) return;

    const users = await q.getAllUsers(db);

    for (const comment of comments) {
      const recipients = users.filter(
        (u) => u.paperclipCompanyId === comment.companyId || u.role === "board",
      );
      if (recipients.length === 0) continue;

      const agentName = await q.getAgentName(db, comment.authorAgentId!);
      const prefix = await q.getCompanyPrefix(db, comment.companyId);
      const isQuestion = comment.body.includes("?");
      const url = `${publicUrl}/${prefix}/issues/${comment.issueId}`;

      const body = comment.body.length > 1000 ? comment.body.slice(0, 1000) + "..." : comment.body;
      let message =
        `<b>${agentName}</b> on <b>${comment.issueIdentifier}: ${comment.issueTitle}</b>\n\n` +
        `${escapeHtml(body)}\n\n` +
        `<a href="${url}">View in Paperclip</a>`;

      if (isQuestion) {
        message = `<b>ACTION NEEDED</b>\n\n${message}\n\nReply to this message to answer`;
      }

      for (const recipient of recipients) {
        try {
          const sent = await bot.api.sendMessage(Number(recipient.telegramChatId), message, {
            parse_mode: "HTML",
            link_preview_options: { is_disabled: true },
          });
          await q.saveMessageMap(db, {
            telegramChatId: recipient.telegramChatId,
            telegramMessageId: String(sent.message_id),
            direction: "outbound",
            paperclipIssueId: comment.issueId,
            paperclipCommentId: comment.id,
            paperclipCompanyId: comment.companyId,
            rawText: message,
          });
        } catch (err: any) {
          log.warn({ err: err.message, chatId: recipient.telegramChatId }, "failed to notify user");
        }
      }
    }

    const lastTs = new Date(new Date(comments[comments.length - 1].createdAt).getTime() + 1);
    await q.setCursor(db, "last_comment_ts", lastTs.toISOString());
  }

  async function pollApprovals() {
    let cursor = await q.getCursor(db, "last_approval_ts");
    if (!cursor) {
      cursor = new Date().toISOString();
      await q.setCursor(db, "last_approval_ts", cursor);
      return;
    }
    const approvalList = await q.getNewApprovals(db, cursor);
    if (approvalList.length === 0) return;

    const users = await q.getAllUsers(db);
    const admins = users.filter((u) => u.role === "board");

    for (const approval of approvalList) {
      const agentName = approval.requestedByAgentId
        ? await q.getAgentName(db, approval.requestedByAgentId)
        : "System";
      const prefix = await q.getCompanyPrefix(db, approval.companyId);
      const payload = approval.payload as Record<string, unknown>;
      const title = (payload?.title as string) ?? (payload?.summary as string) ?? approval.type;
      const body =
        (payload?.body as string) ??
        (payload?.description as string) ??
        JSON.stringify(payload).slice(0, 300);
      const url = `${publicUrl}/${prefix}/approvals/${approval.id}`;

      const message =
        `<b>Approval Required</b>\n\n` +
        `<b>${agentName}</b> requests: <b>${escapeHtml(title)}</b>\n\n` +
        `${escapeHtml(body.slice(0, 500))}\n\n` +
        `<a href="${url}">View in Paperclip</a>`;

      // Short IDs for callback buttons (Telegram 64-byte limit)
      const shortCompany = approval.companyId.replace(/-/g, "").slice(0, 12);
      const shortApproval = approval.id.replace(/-/g, "").slice(0, 12);
      await q.saveCallbackMap(db, shortApproval, approval.companyId, approval.id);

      for (const member of admins) {
        try {
          const sent = await bot.api.sendMessage(Number(member.telegramChatId), message, {
            parse_mode: "HTML",
            link_preview_options: { is_disabled: true },
            reply_markup: {
              inline_keyboard: [
                [
                  { text: "Approve", callback_data: `a:${shortCompany}:${shortApproval}` },
                  { text: "Reject", callback_data: `r:${shortCompany}:${shortApproval}` },
                ],
                [{ text: "View in Paperclip", url }],
              ],
            },
          });
          await q.saveMessageMap(db, {
            telegramChatId: member.telegramChatId,
            telegramMessageId: String(sent.message_id),
            direction: "outbound",
            paperclipCompanyId: approval.companyId,
            rawText: message,
          });
        } catch (err: any) {
          log.warn({ err: err.message, chatId: member.telegramChatId }, "failed to notify admin");
        }
      }
    }

    const lastTs = new Date(
      new Date(approvalList[approvalList.length - 1].createdAt).getTime() + 1,
    );
    await q.setCursor(db, "last_approval_ts", lastTs.toISOString());
  }

  async function pollHumanAssignedIssues() {
    let cursor = await q.getCursor(db, "last_human_issue_ts");
    if (!cursor) {
      cursor = new Date().toISOString();
      await q.setCursor(db, "last_human_issue_ts", cursor);
      return;
    }
    const issues = await q.getNewHumanAssignedIssues(db, cursor);
    if (issues.length === 0) return;

    for (const issue of issues) {
      if (!issue.assigneeUserId) continue;
      const recipient = await q.getUserByPaperclipId(db, issue.assigneeUserId);
      if (!recipient) continue;

      const prefix = await q.getCompanyPrefix(db, issue.companyId);
      const url = `${publicUrl}/${prefix}/issues/${issue.id}`;
      const message =
        `<b>Issue Assigned to You</b>\n\n` +
        `<b>${issue.identifier}: ${issue.title}</b>\n\n` +
        `<a href="${url}">View in Paperclip</a>`;

      try {
        const sent = await bot.api.sendMessage(Number(recipient.telegramChatId), message, {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
        });
        await q.saveMessageMap(db, {
          telegramChatId: recipient.telegramChatId,
          telegramMessageId: String(sent.message_id),
          direction: "outbound",
          paperclipIssueId: issue.id,
          paperclipCompanyId: issue.companyId,
          rawText: message,
        });
      } catch (err: any) {
        log.warn(
          { err: err.message, chatId: recipient.telegramChatId },
          "failed to notify user about assigned issue",
        );
      }
    }

    const lastTs = new Date(new Date(issues[issues.length - 1].createdAt).getTime() + 1);
    await q.setCursor(db, "last_human_issue_ts", lastTs.toISOString());
  }

  async function sendDigest() {
    const users = await q.getAllUsers(db);
    const admins = users.filter((u) => u.role === "board");

    for (const admin of admins) {
      if (!admin.paperclipCompanyId) continue;

      const pendingApprovals = await q.getNewApprovals(
        db,
        new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
      );
      const unansweredQuestions = await q.getUnansweredAgentQuestions(
        db,
        admin.paperclipCompanyId,
      );

      const totalPending = pendingApprovals.length + unansweredQuestions.length;
      if (totalPending === 0) continue;

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

      try {
        await bot.api.sendMessage(Number(admin.telegramChatId), lines.join("\n"), {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
        });
      } catch (err: any) {
        log.warn({ err: err.message, chatId: admin.telegramChatId }, "failed to send digest");
      }
    }
  }

  return {
    stop() {
      state.running = false;
      if (state.safetyPollTimer) clearInterval(state.safetyPollTimer);
      if (state.digestTimer) clearInterval(state.digestTimer);
      for (const [, unsub] of state.companyUnsubscribers) {
        unsub();
      }
      state.companyUnsubscribers.clear();
      if (state.globalUnsubscribe) state.globalUnsubscribe();
    },
  };
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
