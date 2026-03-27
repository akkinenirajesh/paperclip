import { eq, and, desc, asc, gt, isNotNull, sql } from "drizzle-orm";
import {
  telegramUserMap,
  telegramMessageMap,
  telegramCallbackMap,
  telegramPollCursor,
  companies,
  agents,
  issues,
  issueComments,
  approvals,
  heartbeatRuns,
} from "@paperclipai/db";
import type { TelegramUser, ChatContext } from "./types.js";

type Db = any;

// ── User management ──

export async function getUser(db: Db, chatId: string): Promise<TelegramUser | null> {
  const rows = await db
    .select()
    .from(telegramUserMap)
    .where(eq(telegramUserMap.telegramChatId, chatId));
  return rows[0] ?? null;
}

export async function upsertUser(
  db: Db,
  user: Partial<TelegramUser> & { telegramChatId: string },
) {
  await db
    .insert(telegramUserMap)
    .values({
      telegramChatId: user.telegramChatId,
      telegramUsername: user.telegramUsername ?? null,
      telegramDisplayName: user.telegramDisplayName ?? null,
      paperclipUserId: user.paperclipUserId ?? null,
      paperclipCompanyId: user.paperclipCompanyId ?? null,
      role: user.role ?? "member",
    })
    .onConflictDoUpdate({
      target: telegramUserMap.telegramChatId,
      set: {
        ...(user.telegramUsername !== undefined ? { telegramUsername: user.telegramUsername } : {}),
        ...(user.telegramDisplayName !== undefined
          ? { telegramDisplayName: user.telegramDisplayName }
          : {}),
        ...(user.paperclipUserId !== undefined ? { paperclipUserId: user.paperclipUserId } : {}),
        ...(user.paperclipCompanyId !== undefined
          ? { paperclipCompanyId: user.paperclipCompanyId }
          : {}),
        ...(user.role !== undefined ? { role: user.role } : {}),
        updatedAt: new Date(),
      },
    });
}

export async function deleteUser(db: Db, chatId: string) {
  await db.delete(telegramUserMap).where(eq(telegramUserMap.telegramChatId, chatId));
}

export async function getAllUsers(db: Db): Promise<TelegramUser[]> {
  return db.select().from(telegramUserMap);
}

export async function getUserByPaperclipId(
  db: Db,
  paperclipUserId: string,
): Promise<TelegramUser | null> {
  const rows = await db
    .select()
    .from(telegramUserMap)
    .where(eq(telegramUserMap.paperclipUserId, paperclipUserId));
  return rows[0] ?? null;
}

// ── Message mapping ──

export async function saveMessageMap(
  db: Db,
  entry: {
    telegramChatId: string;
    telegramMessageId: string;
    direction: "inbound" | "outbound";
    paperclipIssueId?: string;
    paperclipCommentId?: string;
    paperclipCompanyId?: string;
    agentTaskSessionId?: string;
    rawText?: string;
  },
) {
  await db.insert(telegramMessageMap).values({
    telegramChatId: entry.telegramChatId,
    telegramMessageId: entry.telegramMessageId,
    direction: entry.direction,
    paperclipIssueId: entry.paperclipIssueId ?? null,
    paperclipCommentId: entry.paperclipCommentId ?? null,
    paperclipCompanyId: entry.paperclipCompanyId ?? null,
    agentTaskSessionId: entry.agentTaskSessionId ?? null,
    rawText: entry.rawText ?? null,
  });
}

export async function getRecentChatContext(
  db: Db,
  chatId: string,
  limit = 20,
): Promise<ChatContext[]> {
  const rows = await db
    .select({
      direction: telegramMessageMap.direction,
      rawText: telegramMessageMap.rawText,
      paperclipIssueId: telegramMessageMap.paperclipIssueId,
      createdAt: telegramMessageMap.createdAt,
    })
    .from(telegramMessageMap)
    .where(eq(telegramMessageMap.telegramChatId, chatId))
    .orderBy(desc(telegramMessageMap.createdAt))
    .limit(limit);
  return rows.reverse();
}

export async function getMessageMapByTelegramId(
  db: Db,
  chatId: string,
  messageId: string,
): Promise<{ paperclipIssueId: string | null; paperclipCompanyId: string | null } | null> {
  const rows = await db
    .select({
      paperclipIssueId: telegramMessageMap.paperclipIssueId,
      paperclipCompanyId: telegramMessageMap.paperclipCompanyId,
    })
    .from(telegramMessageMap)
    .where(
      and(
        eq(telegramMessageMap.telegramChatId, chatId),
        eq(telegramMessageMap.telegramMessageId, messageId),
        eq(telegramMessageMap.direction, "outbound"),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

// ── Poll cursor ──

export async function getCursor(db: Db, key: string): Promise<string | null> {
  const rows = await db
    .select({ value: telegramPollCursor.value })
    .from(telegramPollCursor)
    .where(eq(telegramPollCursor.key, key));
  return rows[0]?.value ?? null;
}

export async function setCursor(db: Db, key: string, value: string) {
  await db
    .insert(telegramPollCursor)
    .values({ key, value, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: telegramPollCursor.key,
      set: { value, updatedAt: new Date() },
    });
}

// ── Callback mapping ──

export async function saveCallbackMap(
  db: Db,
  shortId: string,
  companyId: string,
  approvalId: string,
) {
  await db
    .insert(telegramCallbackMap)
    .values({ shortId, companyId, approvalId })
    .onConflictDoNothing();
}

export async function getCallbackMap(
  db: Db,
  shortId: string,
): Promise<{ companyId: string; approvalId: string } | null> {
  const rows = await db
    .select({
      companyId: telegramCallbackMap.companyId,
      approvalId: telegramCallbackMap.approvalId,
    })
    .from(telegramCallbackMap)
    .where(eq(telegramCallbackMap.shortId, shortId));
  return rows[0] ?? null;
}

// ── Paperclip data queries ──

export async function listCompanies(db: Db): Promise<Array<{ id: string; name: string }>> {
  return db
    .select({ id: companies.id, name: companies.name })
    .from(companies)
    .orderBy(desc(companies.createdAt));
}

export async function getCompanyPrefix(db: Db, companyId: string): Promise<string> {
  const rows = await db
    .select({ issuePrefix: companies.issuePrefix })
    .from(companies)
    .where(eq(companies.id, companyId));
  return rows[0]?.issuePrefix ?? "PAP";
}

export async function getCompanyName(db: Db, companyId: string): Promise<string> {
  const rows = await db
    .select({ name: companies.name })
    .from(companies)
    .where(eq(companies.id, companyId));
  return rows[0]?.name ?? "Unknown Company";
}

export async function listAgents(
  db: Db,
  companyId: string,
): Promise<Array<{ id: string; name: string; role: string; status: string }>> {
  return db
    .select({
      id: agents.id,
      name: agents.name,
      role: agents.role,
      status: agents.status,
    })
    .from(agents)
    .where(eq(agents.companyId, companyId));
}

export async function getAgentName(db: Db, agentId: string): Promise<string> {
  const rows = await db
    .select({ name: agents.name })
    .from(agents)
    .where(eq(agents.id, agentId));
  return rows[0]?.name ?? "Unknown Agent";
}

export async function listRecentIssues(
  db: Db,
  companyId: string,
): Promise<Array<{ id: string; identifier: string | null; title: string; status: string }>> {
  return db
    .select({
      id: issues.id,
      identifier: issues.identifier,
      title: issues.title,
      status: issues.status,
    })
    .from(issues)
    .where(eq(issues.companyId, companyId))
    .orderBy(desc(issues.createdAt))
    .limit(20);
}

export async function createIssue(
  db: Db,
  companyId: string,
  opts: {
    title: string;
    description: string;
    assigneeAgentId?: string;
    createdByUserId?: string;
  },
): Promise<{ id: string; identifier: string; title: string }> {
  // Atomically increment issue counter
  const [updated] = await db
    .update(companies)
    .set({
      issueCounter: sql`${companies.issueCounter} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(companies.id, companyId))
    .returning({
      issuePrefix: companies.issuePrefix,
      issueCounter: companies.issueCounter,
    });

  const identifier = `${updated.issuePrefix}-${updated.issueCounter}`;

  const [issue] = await db
    .insert(issues)
    .values({
      companyId,
      title: opts.title,
      description: opts.description,
      status: "todo",
      priority: "medium",
      identifier,
      issueNumber: updated.issueCounter,
      createdByUserId: opts.createdByUserId ?? null,
      assigneeAgentId: opts.assigneeAgentId ?? null,
    })
    .returning({
      id: issues.id,
      identifier: issues.identifier,
      title: issues.title,
    });

  return { id: issue.id, identifier: issue.identifier!, title: issue.title };
}

export async function createIssueComment(
  db: Db,
  companyId: string,
  issueId: string,
  body: string,
  authorUserId?: string,
): Promise<{ id: string }> {
  const [comment] = await db
    .insert(issueComments)
    .values({
      companyId,
      issueId,
      body,
      authorUserId: authorUserId ?? null,
    })
    .returning({ id: issueComments.id });

  // Touch the issue updated_at
  await db
    .update(issues)
    .set({ updatedAt: new Date() })
    .where(eq(issues.id, issueId));

  return comment;
}

export async function updateIssueAssignment(db: Db, issueId: string, agentId: string) {
  await db
    .update(issues)
    .set({ assigneeAgentId: agentId, updatedAt: new Date() })
    .where(eq(issues.id, issueId));
}

export async function getIssueTitle(db: Db, issueId: string): Promise<string> {
  const rows = await db
    .select({ identifier: issues.identifier, title: issues.title })
    .from(issues)
    .where(eq(issues.id, issueId));
  return rows[0] ? `${rows[0].identifier}: ${rows[0].title}` : "Unknown issue";
}

export async function getLatestAgentComment(
  db: Db,
  issueId: string,
): Promise<{ body: string; agentName: string } | null> {
  const rows = await db
    .select({
      body: issueComments.body,
      agentName: agents.name,
    })
    .from(issueComments)
    .innerJoin(agents, eq(agents.id, issueComments.authorAgentId))
    .where(
      and(eq(issueComments.issueId, issueId), isNotNull(issueComments.authorAgentId)),
    )
    .orderBy(desc(issueComments.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

// ── Event polling queries ──

export async function getNewIssueComments(
  db: Db,
  since: string,
): Promise<
  Array<{
    id: string;
    issueId: string;
    companyId: string;
    body: string;
    authorAgentId: string | null;
    createdAt: Date;
    issueTitle: string;
    issueIdentifier: string | null;
  }>
> {
  return db
    .select({
      id: issueComments.id,
      issueId: issueComments.issueId,
      companyId: issues.companyId,
      body: issueComments.body,
      authorAgentId: issueComments.authorAgentId,
      createdAt: issueComments.createdAt,
      issueTitle: issues.title,
      issueIdentifier: issues.identifier,
    })
    .from(issueComments)
    .innerJoin(issues, eq(issues.id, issueComments.issueId))
    .where(
      and(
        gt(issueComments.createdAt, new Date(since)),
        isNotNull(issueComments.authorAgentId),
      ),
    )
    .orderBy(asc(issueComments.createdAt))
    .limit(50);
}

export async function getNewApprovals(
  db: Db,
  since: string,
): Promise<
  Array<{
    id: string;
    companyId: string;
    type: string;
    status: string;
    payload: Record<string, unknown>;
    requestedByAgentId: string | null;
    createdAt: Date;
  }>
> {
  return db
    .select({
      id: approvals.id,
      companyId: approvals.companyId,
      type: approvals.type,
      status: approvals.status,
      payload: approvals.payload,
      requestedByAgentId: approvals.requestedByAgentId,
      createdAt: approvals.createdAt,
    })
    .from(approvals)
    .where(
      and(
        gt(approvals.createdAt, new Date(since)),
        eq(approvals.status, "pending"),
      ),
    )
    .orderBy(asc(approvals.createdAt))
    .limit(50);
}

export async function getNewHumanAssignedIssues(
  db: Db,
  since: string,
): Promise<
  Array<{
    id: string;
    companyId: string;
    identifier: string | null;
    title: string;
    assigneeUserId: string | null;
    createdAt: Date;
  }>
> {
  return db
    .select({
      id: issues.id,
      companyId: issues.companyId,
      identifier: issues.identifier,
      title: issues.title,
      assigneeUserId: issues.assigneeUserId,
      createdAt: issues.createdAt,
    })
    .from(issues)
    .where(
      and(gt(issues.createdAt, new Date(since)), isNotNull(issues.assigneeUserId)),
    )
    .orderBy(asc(issues.createdAt))
    .limit(50);
}

export async function getUnansweredAgentQuestions(
  db: Db,
  companyId: string,
): Promise<
  Array<{
    id: string;
    issueId: string;
    body: string;
    agentName: string;
    issueIdentifier: string | null;
    createdAt: Date;
  }>
> {
  // Agent comments with '?' that have no subsequent human reply
  // Using raw SQL for the NOT EXISTS subquery
  const rows = await db.execute(sql`
    SELECT ic.id, ic.issue_id as "issueId", ic.body, a.name as "agentName",
           i.identifier as "issueIdentifier", ic.created_at as "createdAt"
    FROM issue_comments ic
    JOIN agents a ON a.id = ic.author_agent_id
    JOIN issues i ON i.id = ic.issue_id
    WHERE i.company_id = ${companyId}
      AND ic.author_agent_id IS NOT NULL
      AND ic.body LIKE '%?%'
      AND NOT EXISTS (
        SELECT 1 FROM issue_comments later
        WHERE later.issue_id = ic.issue_id
          AND later.author_user_id IS NOT NULL
          AND later.created_at > ic.created_at
      )
    ORDER BY ic.created_at DESC
    LIMIT 20
  `);
  return rows.rows ?? rows;
}

// ── Approval actions ──

export async function approveApproval(
  db: Db,
  approvalId: string,
  decidedBy: string,
): Promise<string | null> {
  const [row] = await db
    .update(approvals)
    .set({
      status: "approved",
      decidedByUserId: decidedBy,
      decidedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(approvals.id, approvalId), eq(approvals.status, "pending")))
    .returning({
      requestedByAgentId: approvals.requestedByAgentId,
      companyId: approvals.companyId,
      type: approvals.type,
      payload: approvals.payload,
    });

  if (!row) return null;

  // For hire_agent approvals, activate the pending agent
  if (row.type === "hire_agent" && (row.payload as any)?.agentId) {
    await db
      .update(agents)
      .set({ status: "idle", updatedAt: new Date() })
      .where(
        and(eq(agents.id, (row.payload as any).agentId), eq(agents.status, "pending_approval")),
      );
  }

  return row.requestedByAgentId;
}

export async function rejectApproval(
  db: Db,
  approvalId: string,
  decidedBy: string,
  reason?: string,
) {
  await db
    .update(approvals)
    .set({
      status: "rejected",
      decidedByUserId: decidedBy,
      decisionNote: reason ?? null,
      decidedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(approvals.id, approvalId), eq(approvals.status, "pending")));
}
