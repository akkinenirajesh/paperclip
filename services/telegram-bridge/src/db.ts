import pg from "pg";
import { config } from "./config.js";

const pool = new pg.Pool({ connectionString: config.databaseUrl });

/** Run the migration to create telegram bridge tables */
export async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS telegram_user_map (
      telegram_chat_id TEXT PRIMARY KEY,
      telegram_username TEXT,
      telegram_display_name TEXT,
      paperclip_user_id TEXT,
      paperclip_company_id TEXT,
      role TEXT NOT NULL DEFAULT 'member',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS telegram_message_map (
      id SERIAL PRIMARY KEY,
      telegram_chat_id TEXT NOT NULL,
      telegram_message_id TEXT NOT NULL,
      direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
      paperclip_issue_id TEXT,
      paperclip_comment_id TEXT,
      paperclip_company_id TEXT,
      raw_text TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_telegram_msg_chat
      ON telegram_message_map (telegram_chat_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_telegram_msg_issue
      ON telegram_message_map (paperclip_issue_id);

    CREATE TABLE IF NOT EXISTS telegram_callback_map (
      short_id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      approval_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS telegram_poll_cursor (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  console.log("[db] migrations applied");
}

// --- User mapping ---

export interface TelegramUser {
  telegram_chat_id: string;
  telegram_username: string | null;
  telegram_display_name: string | null;
  paperclip_user_id: string | null;
  paperclip_company_id: string | null;
  role: string;
}

export async function getUser(chatId: string): Promise<TelegramUser | null> {
  const { rows } = await pool.query(
    "SELECT * FROM telegram_user_map WHERE telegram_chat_id = $1",
    [chatId]
  );
  return rows[0] ?? null;
}

export async function upsertUser(user: Partial<TelegramUser> & { telegram_chat_id: string }) {
  await pool.query(
    `INSERT INTO telegram_user_map (telegram_chat_id, telegram_username, telegram_display_name, paperclip_user_id, paperclip_company_id, role)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (telegram_chat_id) DO UPDATE SET
       telegram_username = COALESCE(EXCLUDED.telegram_username, telegram_user_map.telegram_username),
       telegram_display_name = COALESCE(EXCLUDED.telegram_display_name, telegram_user_map.telegram_display_name),
       paperclip_user_id = COALESCE(EXCLUDED.paperclip_user_id, telegram_user_map.paperclip_user_id),
       paperclip_company_id = COALESCE(EXCLUDED.paperclip_company_id, telegram_user_map.paperclip_company_id),
       role = COALESCE(EXCLUDED.role, telegram_user_map.role),
       updated_at = NOW()`,
    [
      user.telegram_chat_id,
      user.telegram_username ?? null,
      user.telegram_display_name ?? null,
      user.paperclip_user_id ?? null,
      user.paperclip_company_id ?? null,
      user.role ?? "member",
    ]
  );
}

export async function deleteUser(chatId: string) {
  await pool.query("DELETE FROM telegram_user_map WHERE telegram_chat_id = $1", [chatId]);
}

export async function getAllUsers(): Promise<TelegramUser[]> {
  const { rows } = await pool.query("SELECT * FROM telegram_user_map");
  return rows;
}

// --- Message mapping ---

export async function saveMessageMap(entry: {
  telegram_chat_id: string;
  telegram_message_id: string;
  direction: "inbound" | "outbound";
  paperclip_issue_id?: string;
  paperclip_comment_id?: string;
  paperclip_company_id?: string;
  raw_text?: string;
}) {
  await pool.query(
    `INSERT INTO telegram_message_map
       (telegram_chat_id, telegram_message_id, direction, paperclip_issue_id, paperclip_comment_id, paperclip_company_id, raw_text)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      entry.telegram_chat_id,
      entry.telegram_message_id,
      entry.direction,
      entry.paperclip_issue_id ?? null,
      entry.paperclip_comment_id ?? null,
      entry.paperclip_company_id ?? null,
      entry.raw_text ?? null,
    ]
  );
}

export async function getRecentChatContext(chatId: string, limit = 20): Promise<Array<{
  direction: string;
  raw_text: string;
  paperclip_issue_id: string | null;
  created_at: Date;
}>> {
  const { rows } = await pool.query(
    `SELECT direction, raw_text, paperclip_issue_id, created_at
     FROM telegram_message_map
     WHERE telegram_chat_id = $1
     ORDER BY created_at DESC LIMIT $2`,
    [chatId, limit]
  );
  return rows.reverse();
}

// --- Poll cursor ---

export async function getCursor(key: string): Promise<string | null> {
  const { rows } = await pool.query(
    "SELECT value FROM telegram_poll_cursor WHERE key = $1",
    [key]
  );
  return rows[0]?.value ?? null;
}

export async function setCursor(key: string, value: string) {
  await pool.query(
    `INSERT INTO telegram_poll_cursor (key, value, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [key, value]
  );
}

// --- Callback mapping (short ID → full UUIDs for Telegram buttons) ---

export async function saveCallbackMap(shortId: string, companyId: string, approvalId: string) {
  await pool.query(
    `INSERT INTO telegram_callback_map (short_id, company_id, approval_id)
     VALUES ($1, $2, $3) ON CONFLICT (short_id) DO NOTHING`,
    [shortId, companyId, approvalId]
  );
}

export async function getCallbackMap(shortId: string): Promise<{ company_id: string; approval_id: string } | null> {
  const { rows } = await pool.query(
    "SELECT company_id, approval_id FROM telegram_callback_map WHERE short_id = $1",
    [shortId]
  );
  return rows[0] ?? null;
}

// --- Direct Paperclip DB queries for event polling ---

export async function getNewIssueComments(since: string): Promise<Array<{
  id: string;
  issue_id: string;
  company_id: string;
  body: string;
  author_agent_id: string | null;
  author_user_id: string | null;
  created_at: string;
  issue_title: string;
  issue_identifier: string;
}>> {
  const { rows } = await pool.query(
    `SELECT ic.id, ic.issue_id, i.company_id, ic.body,
            ic.author_agent_id, ic.author_user_id, ic.created_at,
            i.title as issue_title, i.identifier as issue_identifier
     FROM issue_comments ic
     JOIN issues i ON i.id = ic.issue_id
     WHERE ic.created_at > $1
       AND ic.author_agent_id IS NOT NULL
     ORDER BY ic.created_at ASC
     LIMIT 50`,
    [since]
  );
  return rows;
}

export async function getNewApprovals(since: string): Promise<Array<{
  id: string;
  company_id: string;
  type: string;
  status: string;
  payload: Record<string, unknown>;
  requested_by_agent_id: string | null;
  created_at: string;
}>> {
  const { rows } = await pool.query(
    `SELECT id, company_id, type, status, payload,
            requested_by_agent_id, created_at
     FROM approvals
     WHERE created_at > $1 AND status = 'pending'
     ORDER BY created_at ASC
     LIMIT 50`,
    [since]
  );
  return rows;
}

export async function getNewHumanAssignedIssues(since: string): Promise<Array<{
  id: string;
  company_id: string;
  identifier: string;
  title: string;
  assignee_user_id: string;
  created_at: string;
}>> {
  const { rows } = await pool.query(
    `SELECT i.id, i.company_id, i.identifier, i.title,
            i.assignee_user_id, i.created_at
     FROM issues i
     WHERE i.created_at > $1
       AND i.assignee_user_id IS NOT NULL
     ORDER BY i.created_at ASC
     LIMIT 50`,
    [since]
  );
  return rows;
}

export async function getUserByPaperclipId(paperclipUserId: string): Promise<TelegramUser | null> {
  const { rows } = await pool.query(
    "SELECT * FROM telegram_user_map WHERE paperclip_user_id = $1",
    [paperclipUserId]
  );
  return rows[0] ?? null;
}

export async function getAgentName(agentId: string): Promise<string> {
  const { rows } = await pool.query(
    "SELECT name FROM agents WHERE id = $1",
    [agentId]
  );
  return rows[0]?.name ?? "Unknown Agent";
}

export async function getCompanyName(companyId: string): Promise<string> {
  const { rows } = await pool.query(
    "SELECT name FROM companies WHERE id = $1",
    [companyId]
  );
  return rows[0]?.name ?? "Unknown Company";
}

export async function getCompanyPrefix(companyId: string): Promise<string> {
  const { rows } = await pool.query(
    "SELECT issue_prefix FROM companies WHERE id = $1",
    [companyId]
  );
  return rows[0]?.issue_prefix ?? "PAP";
}

// --- Companies, Issues, Agents (direct DB reads) ---

export async function listCompanies(): Promise<Array<{ id: string; name: string }>> {
  const { rows } = await pool.query("SELECT id, name FROM companies ORDER BY created_at DESC");
  return rows;
}

export async function listRecentIssues(companyId: string): Promise<Array<{
  id: string; identifier: string; title: string; status: string;
}>> {
  const { rows } = await pool.query(
    `SELECT id, identifier, title, status FROM issues
     WHERE company_id = $1 ORDER BY created_at DESC LIMIT 20`,
    [companyId]
  );
  return rows;
}

export async function listAgents(companyId: string): Promise<Array<{
  id: string; name: string; role: string; status: string;
}>> {
  const { rows } = await pool.query(
    "SELECT id, name, role, status FROM agents WHERE company_id = $1",
    [companyId]
  );
  return rows;
}

// --- Create issues and comments directly in DB ---

export async function createIssue(companyId: string, opts: {
  title: string; description: string; assigneeAgentId?: string; createdByUserId?: string;
}): Promise<{ id: string; identifier: string; title: string }> {
  const counterResult = await pool.query(
    `UPDATE companies SET issue_counter = issue_counter + 1, updated_at = NOW()
     WHERE id = $1 RETURNING issue_prefix, issue_counter`,
    [companyId]
  );
  const { issue_prefix, issue_counter } = counterResult.rows[0];
  const identifier = `${issue_prefix}-${issue_counter}`;

  const { rows } = await pool.query(
    `INSERT INTO issues (company_id, title, description, status, priority, identifier, issue_number, created_by_user_id, assignee_agent_id)
     VALUES ($1, $2, $3, 'todo', 'medium', $4, $5, $6, $7)
     RETURNING id, identifier, title`,
    [companyId, opts.title, opts.description, identifier, issue_counter, opts.createdByUserId ?? null, opts.assigneeAgentId ?? null]
  );
  console.log(`[db] created issue ${identifier} assigned to agent ${opts.assigneeAgentId ?? "none"}`);
  return rows[0];
}

export async function updateIssueAssignment(issueId: string, agentId: string): Promise<void> {
  await pool.query(
    "UPDATE issues SET assignee_agent_id = $2, updated_at = NOW() WHERE id = $1",
    [issueId, agentId]
  );
  console.log(`[db] reassigned issue ${issueId} to agent ${agentId}`);
}

export async function createIssueComment(companyId: string, issueId: string, body: string, authorUserId?: string): Promise<{
  id: string;
}> {
  const { rows } = await pool.query(
    `INSERT INTO issue_comments (company_id, issue_id, body, author_user_id)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [companyId, issueId, body, authorUserId ?? null]
  );
  // Also touch the issue updated_at so it shows activity
  await pool.query(
    "UPDATE issues SET updated_at = NOW() WHERE id = $1",
    [issueId]
  );
  return rows[0];
}

// --- Trigger agent heartbeat ---

export async function triggerHeartbeat(companyId: string): Promise<void> {
  // Find active or idle agents for this company and queue a heartbeat run
  const { rows: agents } = await pool.query(
    "SELECT id FROM agents WHERE company_id = $1 AND status IN ('active', 'idle') ORDER BY (role = 'ceo') DESC LIMIT 1",
    [companyId]
  );
  if (agents.length === 0) {
    console.log("[db] no active agents to trigger heartbeat for");
    return;
  }
  await pool.query(
    `INSERT INTO heartbeat_runs (company_id, agent_id, invocation_source, status, trigger_detail)
     VALUES ($1, $2, 'on_demand', 'queued', 'telegram-bridge')`,
    [companyId, agents[0].id]
  );
  console.log(`[db] queued heartbeat for agent ${agents[0].id}`);
}

// --- Approval actions via DB ---

export async function approveApproval(approvalId: string, decidedBy: string): Promise<string | null> {
  const { rows } = await pool.query(
    `UPDATE approvals SET status = 'approved', decided_by_user_id = $2, decided_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND status = 'pending' RETURNING requested_by_agent_id, company_id, type, payload`,
    [approvalId, decidedBy]
  );
  if (rows.length === 0) return null;

  // For hire_agent approvals, activate the pending agent
  if (rows[0].type === "hire_agent" && rows[0].payload?.agentId) {
    await pool.query(
      `UPDATE agents SET status = 'idle', updated_at = NOW()
       WHERE id = $1 AND status = 'pending_approval'`,
      [rows[0].payload.agentId]
    );
    console.log(`[db] activated pending agent ${rows[0].payload.agentId}`);
  }

  // Wake the requesting agent
  if (rows[0].requested_by_agent_id) {
    await pool.query(
      `INSERT INTO heartbeat_runs (company_id, agent_id, invocation_source, status, trigger_detail)
       VALUES ($1, $2, 'on_demand', 'queued', 'approval_approved')`,
      [rows[0].company_id, rows[0].requested_by_agent_id]
    );
    console.log(`[db] approval ${approvalId} approved, woke agent ${rows[0].requested_by_agent_id}`);
  }
  return rows[0].requested_by_agent_id;
}

export async function rejectApproval(approvalId: string, decidedBy: string, reason?: string): Promise<void> {
  await pool.query(
    `UPDATE approvals SET status = 'rejected', decided_by_user_id = $2, decision_note = $3, decided_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND status = 'pending'`,
    [approvalId, decidedBy, reason ?? null]
  );
  console.log(`[db] approval ${approvalId} rejected`);
}

/** Get the latest agent comment on an issue (to surface pending questions) */
export async function getLatestAgentComment(issueId: string): Promise<{ body: string; agent_name: string } | null> {
  const { rows } = await pool.query(
    `SELECT ic.body, a.name as agent_name
     FROM issue_comments ic
     JOIN agents a ON a.id = ic.author_agent_id
     WHERE ic.issue_id = $1 AND ic.author_agent_id IS NOT NULL
     ORDER BY ic.created_at DESC LIMIT 1`,
    [issueId]
  );
  return rows[0] ?? null;
}

/** Get issue title by ID */
export async function getIssueTitle(issueId: string): Promise<string> {
  const { rows } = await pool.query("SELECT identifier, title FROM issues WHERE id = $1", [issueId]);
  return rows[0] ? `${rows[0].identifier}: ${rows[0].title}` : "Unknown issue";
}

/** Look up an outbound message by its Telegram chat + message ID (for reply-to routing) */
export async function getMessageMapByTelegramId(chatId: string, messageId: string): Promise<{
  paperclip_issue_id: string | null;
  paperclip_company_id: string | null;
} | null> {
  const { rows } = await pool.query(
    `SELECT paperclip_issue_id, paperclip_company_id
     FROM telegram_message_map
     WHERE telegram_chat_id = $1 AND telegram_message_id = $2 AND direction = 'outbound'
     LIMIT 1`,
    [chatId, messageId]
  );
  return rows[0] ?? null;
}

/** Find agent comments with '?' that have no subsequent human reply */
export async function getUnansweredAgentQuestions(companyId: string): Promise<Array<{
  id: string;
  issue_id: string;
  body: string;
  agent_name: string;
  issue_identifier: string;
  created_at: string;
}>> {
  const { rows } = await pool.query(
    `SELECT ic.id, ic.issue_id, ic.body, a.name as agent_name, i.identifier as issue_identifier, ic.created_at
     FROM issue_comments ic
     JOIN agents a ON a.id = ic.author_agent_id
     JOIN issues i ON i.id = ic.issue_id
     WHERE i.company_id = $1
       AND ic.author_agent_id IS NOT NULL
       AND ic.body LIKE '%?%'
       AND NOT EXISTS (
         SELECT 1 FROM issue_comments later
         WHERE later.issue_id = ic.issue_id
           AND later.author_user_id IS NOT NULL
           AND later.created_at > ic.created_at
       )
     ORDER BY ic.created_at DESC
     LIMIT 20`,
    [companyId]
  );
  return rows;
}

export { pool };
