import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { eq } from "drizzle-orm";
import { heartbeatRuns } from "@paperclipai/db";
import * as q from "./queries.js";
import { telegramLog as log } from "./bot.js";
import { createLocalAgentJwt } from "../../agent-auth-jwt.js";

interface AgentDeps {
  db: any;
  heartbeatService: any;
  publicUrl: string;
}

interface AgentResult {
  reply: string | null;
  createdIssueId: string | null;
}

export interface MessageMeta {
  chatId: string;
  senderName: string;
  isReply: boolean;
  replyTo: { issueId?: string; originalText?: string } | null;
  timestamp: string;
}

// ── Skills directory setup (same pattern as claude-local adapter) ──

const SKILLS_CANDIDATES = [
  path.resolve(process.cwd(), "skills"),
  path.resolve(process.cwd(), "../skills"),
  "/app/skills",
];

async function findSkillsDir(): Promise<string | null> {
  for (const candidate of SKILLS_CANDIDATES) {
    const isDir = await fs.stat(candidate).then((s) => s.isDirectory()).catch(() => false);
    if (isDir) return candidate;
  }
  return null;
}

async function buildSkillsDir(): Promise<string> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "telegram-skills-"));
  const target = path.join(tmp, ".claude", "skills");
  await fs.mkdir(target, { recursive: true });

  // Symlink all Paperclip skills
  const skillsDir = await findSkillsDir();
  if (skillsDir) {
    const entries = await fs.readdir(skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        await fs.symlink(path.join(skillsDir, entry.name), path.join(target, entry.name));
      }
    }
  }

  // Write the telegram-specific skill
  const telegramSkillDir = path.join(target, "telegram-responder");
  await fs.mkdir(telegramSkillDir, { recursive: true });
  await fs.writeFile(path.join(telegramSkillDir, "SKILL.md"), TELEGRAM_SKILL);

  return tmp;
}

// Cached skills dir (rebuilt on each process start)
let cachedSkillsDir: string | null = null;

async function getSkillsDir(): Promise<string> {
  if (!cachedSkillsDir) {
    cachedSkillsDir = await buildSkillsDir();
    log.info({ skillsDir: cachedSkillsDir }, "telegram skills dir built");
  }
  return cachedSkillsDir;
}

// ── Telegram skill prompt ──

const TELEGRAM_SKILL = `# Telegram Responder

You are handling an incoming Telegram message from a company board member or team member.
Your job: understand what they want and respond appropriately.

## When to just reply

- Greetings, casual messages ("hi", "you there?", "thanks")
- Questions about status → check recent issues via the Paperclip API
- General conversation

For these, just output your reply text directly. Keep it concise — this is Telegram.

## When to create an issue

- The human is giving instructions, reporting a problem, making a request
- The message has substantive business content that the AI team should act on

Use the Paperclip API to create an issue:
\`\`\`
curl -s -X POST "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/issues" \\
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \\
  -H "Content-Type: application/json" \\
  -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" \\
  -d '{"title":"...","description":"...","status":"todo","priority":"medium"}'
\`\`\`

Then confirm to the user what you created.

## When to add a comment to an existing issue

- The human is following up on something already tracked
- They're answering an agent's question about a specific issue

Use the API to add a comment:
\`\`\`
curl -s -X POST "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/issues/{issueId}/comments" \\
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \\
  -H "Content-Type: application/json" \\
  -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" \\
  -d '{"body":"...", "reopen": true}'
\`\`\`

**Important**: Always pass \`"reopen": true\` when commenting on a done/cancelled issue — this reopens it so agents pick it up again.

When reopening, check who created the issue (created_by_agent_id field) and reassign to that agent so they pick it back up. Only AI agents can mark issues done, so always make sure the issue is assigned to an AI agent (assignee_agent_id), not a human. If created_by_agent_id is not available, assign to the CEO.
\`\`\`
curl -s -X PATCH "$PAPERCLIP_API_URL/api/issues/{issueId}" \\
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \\
  -H "Content-Type: application/json" \\
  -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" \\
  -d '{"assigneeAgentId":"{createdByAgentId or ceoAgentId}"}'
\`\`\`

To get issue details (including createdByAgentId for reassignment):
\`\`\`
curl -s "$PAPERCLIP_API_URL/api/issues/{issueId}" \\
  -H "Authorization: Bearer $PAPERCLIP_API_KEY"
\`\`\`
The response includes \`createdByAgentId\` — use this when reassigning a reopened issue.

## Searching for issues

Before creating a new issue, search for existing ones:
\`\`\`
curl -s "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/issues?q=search+term&limit=10" \\
  -H "Authorization: Bearer $PAPERCLIP_API_KEY"
\`\`\`

## Listing agents

To find agent IDs (e.g. the CEO) for assignment:
\`\`\`
curl -s "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/agents" \\
  -H "Authorization: Bearer $PAPERCLIP_API_KEY"
\`\`\`

## Rules

1. ALWAYS output a reply for the human. They're waiting in Telegram.
2. Be concise. Use Telegram HTML formatting: <b>bold</b>, <i>italic</i>, <code>code</code>.
3. Don't create issues for casual conversation.
4. When you create an issue, include the issue identifier in your reply.
5. When in doubt about intent, just ask — don't create a wrong issue.
6. You have access to the Paperclip API for searching issues, getting agent info, etc.
   Base URL: $PAPERCLIP_API_URL, Auth: Bearer $PAPERCLIP_API_KEY
`;

// ── Session tracking (per-chat claude session persistence) ──

interface ChatSession {
  sessionId: string;
  lastUsedAt: number;
}

const chatSessions = new Map<string, ChatSession>();
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 min inactivity → new session

function getSessionForChat(chatId: string): string | null {
  const session = chatSessions.get(chatId);
  if (!session) return null;
  if (Date.now() - session.lastUsedAt > SESSION_TTL_MS) {
    chatSessions.delete(chatId);
    return null;
  }
  return session.sessionId;
}

function saveSessionForChat(chatId: string, sessionId: string): void {
  chatSessions.set(chatId, { sessionId, lastUsedAt: Date.now() });
}

// ── Run claude CLI ──

interface ClaudeResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

function runClaude(
  prompt: string,
  env: Record<string, string>,
  skillsDir: string,
  resumeSessionId: string | null,
  onActivity?: () => void,
): Promise<ClaudeResult> {
  return new Promise((resolve) => {
    const args = [
      "--print", "-",
      "--output-format", "stream-json",
      "--verbose",
      "--dangerously-skip-permissions",
      "--max-turns", "8",
      "--add-dir", skillsDir,
    ];
    if (resumeSessionId) {
      args.push("--resume", resumeSessionId);
    }

    const child = spawn("claude", args, {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let lastActivityAt = Date.now();

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      lastActivityAt = Date.now();
      onActivity?.();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      lastActivityAt = Date.now();
    });

    // Write prompt to stdin
    child.stdin.write(prompt);
    child.stdin.end();

    // No hard timeout — instead, kill only if no output for 2 minutes (truly stuck)
    const staleCheck = setInterval(() => {
      if (Date.now() - lastActivityAt > 120_000) {
        log.warn("claude process stale (no output for 2 min), killing");
        child.kill("SIGTERM");
      }
    }, 10_000);

    child.on("close", (code) => {
      clearInterval(staleCheck);
      resolve({ stdout, stderr, exitCode: code });
    });

    child.on("error", (err) => {
      clearInterval(staleCheck);
      log.error({ err }, "claude process error");
      resolve({ stdout, stderr, exitCode: -1 });
    });
  });
}

// ── Parse stream-json output ──

interface ParsedOutput {
  reply: string | null;
  sessionId: string | null;
}

function parseStreamJson(stdout: string): ParsedOutput {
  const assistantTexts: string[] = [];
  let sessionId: string | null = null;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    // Extract session_id from any event that has it
    if (event.session_id && typeof event.session_id === "string") {
      sessionId = event.session_id;
    }

    // Assistant text messages contain the reply
    if (event.type === "assistant" && event.message?.content) {
      for (const block of event.message.content) {
        if (block.type === "text" && block.text) {
          assistantTexts.push(block.text);
        }
      }
    }

    // Result event has the final text
    if (event.type === "result" && typeof event.result === "string" && event.result.trim()) {
      return { reply: event.result, sessionId };
    }
  }

  // No result event — use the last assistant text block
  // (happens when Claude spent all turns on tool calls)
  const reply = assistantTexts.length > 0 ? assistantTexts[assistantTexts.length - 1] : null;
  return { reply, sessionId };
}

// ── Main entry point ──

export async function runTelegramAgent(
  deps: AgentDeps,
  chatId: string,
  companyId: string,
  messageText: string,
  recentContext: Array<{ direction: string; rawText: string | null; paperclipIssueId: string | null; createdAt: Date }>,
  messageMeta?: MessageMeta,
): Promise<AgentResult> {
  const { db, publicUrl } = deps;

  // Find the CEO agent (or first active agent) to generate a JWT
  const agents = await q.listAgents(db, companyId);
  const ceoAgent = agents.find((a) => a.role === "ceo") ?? agents.find((a) => a.status === "active" || a.status === "idle");

  if (!ceoAgent) {
    return { reply: "No active agents found for this company.", createdIssueId: null };
  }

  // Create a real heartbeat_runs row so the run ID satisfies FK constraints
  // when the agent calls APIs that log activity
  const runId = randomUUID();
  await db.insert(heartbeatRuns).values({
    id: runId,
    companyId,
    agentId: ceoAgent.id,
    invocationSource: "on_demand",
    triggerDetail: "telegram",
    status: "running",
    startedAt: new Date(),
    contextSnapshot: { source: "telegram", chatId },
  });

  const finalizeRun = async (status: "completed" | "failed", error?: string) => {
    try {
      await db
        .update(heartbeatRuns)
        .set({ status, finishedAt: new Date(), error: error ?? null, updatedAt: new Date() })
        .where(eq(heartbeatRuns.id, runId));
    } catch (err) {
      log.warn({ err, runId }, "failed to finalize telegram heartbeat run");
    }
  };

  // Generate a short-lived JWT so the agent can call the Paperclip API
  const jwt = createLocalAgentJwt(ceoAgent.id, companyId, "claude_local", runId);

  if (!jwt) {
    log.warn("Could not create agent JWT — telegram agent won't have API access");
  }

  // Build environment
  const runtimeHost = process.env.PAPERCLIP_LISTEN_HOST ?? process.env.HOST ?? "localhost";
  const resolvedHost = (!runtimeHost || runtimeHost === "0.0.0.0" || runtimeHost === "::") ? "localhost" : runtimeHost;
  const runtimePort = process.env.PAPERCLIP_LISTEN_PORT ?? process.env.PORT ?? "3100";
  const apiUrl = process.env.PAPERCLIP_API_URL ?? `http://${resolvedHost}:${runtimePort}`;

  const env: Record<string, string> = {
    PAPERCLIP_AGENT_ID: ceoAgent.id,
    PAPERCLIP_COMPANY_ID: companyId,
    PAPERCLIP_API_URL: apiUrl,
    PAPERCLIP_RUN_ID: runId,
  };
  if (jwt) {
    env.PAPERCLIP_API_KEY = jwt;
  }

  // Check for existing session for this chat
  const existingSessionId = getSessionForChat(chatId);

  // Build message metadata block — always included so agent has full context
  const metaLines: string[] = [];
  if (messageMeta) {
    metaLines.push(`From: ${messageMeta.senderName}`);
    metaLines.push(`Time: ${messageMeta.timestamp}`);
    if (messageMeta.isReply && messageMeta.replyTo) {
      metaLines.push(`Reply-to: "${messageMeta.replyTo.originalText ?? "(unknown message)"}"`);
      if (messageMeta.replyTo.issueId) {
        metaLines.push(`Linked issue: ${messageMeta.replyTo.issueId}`);
      }
    }
  }
  const metaBlock = metaLines.length > 0 ? `[${metaLines.join(" | ")}]\n` : "";

  let prompt: string;
  if (existingSessionId) {
    // Resumed session — claude has the conversation history, but always
    // include message metadata so it knows reply context
    prompt = `${metaBlock}${messageText}`;
  } else {
    // First message in a new session — include full context
    const contextLines = recentContext.slice(-15).map((m) => {
      const dir = m.direction === "inbound" ? "Human" : "Bot";
      const issue = m.paperclipIssueId ? ` [issue:${m.paperclipIssueId}]` : "";
      return `[${dir}${issue}] ${m.rawText?.slice(0, 300) ?? ""}`;
    });

    prompt = [
      `You are handling Telegram messages for company ${companyId}.`,
      `Public URL: ${publicUrl}`,
      ``,
      contextLines.length > 0 ? `Recent chat history:\n${contextLines.join("\n")}\n` : "",
      `${metaBlock}New message from human:\n${messageText}`,
      ``,
      `Respond to this message. Output ONLY your reply text — nothing else. If you need to create an issue or call the API, do that first, then output your reply.`,
    ].join("\n");
  }

  log.info(
    { chatId, messageLength: messageText.length, resuming: !!existingSessionId },
    "running telegram agent",
  );

  const skillsDir = await getSkillsDir();
  const proc = await runClaude(prompt, env, skillsDir, existingSessionId, () => {
    // Called on every stdout chunk — lets the handler know the agent is still alive
    // (used to keep typing indicator going)
  });

  if (proc.exitCode !== 0 && proc.exitCode !== null) {
    log.warn({ exitCode: proc.exitCode, stderr: proc.stderr.slice(0, 500) }, "claude exited with error");

    // If resume failed, retry without session
    if (existingSessionId) {
      log.info({ chatId }, "resume failed, retrying with fresh session");
      chatSessions.delete(chatId);
      const retryProc = await runClaude(prompt, env, skillsDir, null, undefined);
      const retryParsed = parseStreamJson(retryProc.stdout);
      if (retryParsed.sessionId) {
        saveSessionForChat(chatId, retryParsed.sessionId);
      }
      await finalizeRun("completed");
      return { reply: retryParsed.reply ?? "I couldn't process that. Please try again.", createdIssueId: null };
    }
  }

  // Parse the response
  const parsed = parseStreamJson(proc.stdout);

  // Save session for future messages in this chat
  if (parsed.sessionId) {
    saveSessionForChat(chatId, parsed.sessionId);
    log.info({ chatId, sessionId: parsed.sessionId, resumed: !!existingSessionId }, "session tracked");
  }

  if (!parsed.reply) {
    log.warn({ stdoutLength: proc.stdout.length }, "no reply extracted from claude output");
    await finalizeRun("failed", "no reply extracted");
    return { reply: "I couldn't process that. Please try again.", createdIssueId: null };
  }

  log.info({ chatId, replyLength: parsed.reply.length }, "telegram agent replied");
  await finalizeRun("completed");
  return { reply: parsed.reply, createdIssueId: null };
}
