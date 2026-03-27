import OpenAI from "openai";
import { config } from "./config.js";

const client = new OpenAI({
  apiKey: config.openrouterApiKey,
  baseURL: "https://openrouter.ai/api/v1",
});

export interface MessageClassification {
  intent: "new_issue" | "reply_to_issue" | "approval_response" | "status_query" | "general";
  issueId?: string;
  title?: string;
  body: string;
  approvalAction?: "approve" | "reject" | "request_revision";
  approvalId?: string;
  assignTo?: string; // agent ID to assign the issue to
}

/**
 * Classify an incoming Telegram message using AI.
 * Given chat context, determine if this is a new issue, a reply, an approval action, etc.
 */
export async function classifyMessage(
  messageText: string,
  chatContext: Array<{ direction: string; raw_text: string; paperclip_issue_id: string | null }>,
  pendingApprovals: Array<{ id: string; title: string }>,
  availableAgents: Array<{ id: string; name: string; role: string }>,
): Promise<MessageClassification> {
  // Find the most recent issue ID in context for reply detection
  const lastIssueId = chatContext
    .slice(-10)
    .reverse()
    .find((m) => m.paperclip_issue_id)?.paperclip_issue_id ?? null;

  const contextStr = chatContext
    .slice(-10)
    .map((m) => {
      const tag = m.paperclip_issue_id ? ` [ISSUE:${m.paperclip_issue_id}]` : "";
      return `[${m.direction}${tag}] ${m.raw_text?.slice(0, 200) ?? ""}`;
    })
    .join("\n");

  const approvalsStr = pendingApprovals.length > 0
    ? `Pending approvals:\n${pendingApprovals.map((a) => `- ID: ${a.id} — "${a.title}"`).join("\n")}`
    : "No pending approvals.";

  const agentsStr = availableAgents.length > 0
    ? `Available agents:\n${availableAgents.map((a) => `- ID: ${a.id} | Name: ${a.name} | Role: ${a.role}`).join("\n")}`
    : "No agents available.";

  const response = await client.chat.completions.create({
    model: config.aiModel,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `You are a message router for Paperclip, an AI-managed company. Your job is to classify each incoming human message and return JSON.

OUTPUT FORMAT (strict JSON, no markdown):
{
  "intent": "new_issue" | "reply_to_issue" | "approval_response" | "status_query" | "general",
  "issueId": "<uuid from chat context, only for reply_to_issue>",
  "title": "<short issue title, required for new_issue>",
  "body": "<cleaned message text for the issue/comment body>",
  "approvalAction": "approve" | "reject" | "request_revision",
  "approvalId": "<uuid>",
  "assignTo": "<agent ID to assign the issue to, pick the most relevant agent based on their name and role>"
}

CLASSIFICATION RULES — follow these in ORDER:

1. "general" — ONLY for single-word greetings like "hi", "ok", "thanks", "bye", or messages with zero business content.

2. "approval_response" — The human explicitly approves/rejects AND there are pending approvals listed.

3. "reply_to_issue" — The chat context shows a recent issue (with issueId), and this message clearly continues that thread.

4. "status_query" — The human is ASKING a question about what's happening. Contains "?" or words like "status", "update", "progress", "how is".

5. "new_issue" — EVERYTHING ELSE. This is the DEFAULT. Any message that contains information, instructions, updates, reports, requests, decisions, or directives MUST be classified as "new_issue". Examples:
   - "Inform the CEO that X" → new_issue, title: "Inform CEO: X"
   - "We fixed the bug" → new_issue, title: "Bug fix completed"
   - "Deploy to production today" → new_issue, title: "Deploy to production"
   - "The server is down" → new_issue, title: "Server down"

6. "assignTo" — For new_issue, pick the best agent from the available agents list based on the message content and the agent's name/role. If the message mentions a specific role (CEO, CTO, engineer), assign to that agent. If unsure, assign to the CEO or the first agent.

If you are unsure about intent, return "new_issue". Never return "general" for a message with more than 3 words that contains business-relevant information.`,
      },
      {
        role: "user",
        content: `Recent chat context:\n${contextStr}\n\n${lastIssueId ? `ACTIVE ISSUE IN CONVERSATION: ${lastIssueId} — if the human's message relates to this issue thread, use intent "reply_to_issue" with this issueId.\n\n` : ""}${approvalsStr}\n\n${agentsStr}\n\nNew message from human:\n${messageText}`,
      },
    ],
  });

  const content = response.choices[0]?.message?.content ?? "{}";
  try {
    return JSON.parse(content) as MessageClassification;
  } catch {
    return { intent: "general", body: messageText };
  }
}

/**
 * Format a Paperclip event into a human-friendly Telegram message.
 */
export async function formatNotification(event: {
  type: string;
  agentName?: string;
  companyName: string;
  title?: string;
  body?: string;
  issueIdentifier?: string;
  issueTitle?: string;
  approvalId?: string;
  publicUrl: string;
}): Promise<string> {
  const response = await client.chat.completions.create({
    model: config.aiModel,
    temperature: 0.3,
    messages: [
      {
        role: "system",
        content: `You format notifications from an AI company (Paperclip) for a human reading on Telegram.
Use Telegram HTML formatting (<b>, <i>, <code>, <a>). No markdown.
Always mention which agent, company, and issue identifier this is from.
Max 1500 chars.

IMPORTANT rules:
- If the body contains QUESTIONS for the human, you MUST preserve ALL questions in the notification. Do not summarize them away.
- If the agent is asking for input/decisions, end with: "💬 <b>Reply here to respond</b>"
- Include a direct link if a URL is provided.
- For status updates with no questions, keep it brief.`,
      },
      {
        role: "user",
        content: JSON.stringify(event),
      },
    ],
  });

  return response.choices[0]?.message?.content ?? `[${event.type}] ${event.title ?? event.body ?? "New notification"}`;
}

/**
 * Generate a conversational reply to a general or status query message.
 */
export async function generateReply(
  messageText: string,
  chatContext: Array<{ direction: string; raw_text: string }>,
  companyContext: string,
): Promise<string> {
  const contextStr = chatContext
    .slice(-10)
    .map((m) => `[${m.direction}] ${m.raw_text}`)
    .join("\n");

  const response = await client.chat.completions.create({
    model: config.aiModel,
    temperature: 0.5,
    messages: [
      {
        role: "system",
        content: `You are the communications interface for an AI-managed company on Paperclip.
You respond to humans on behalf of the AI team. Be helpful, concise, and professional.
Use Telegram HTML formatting. Keep responses under 500 chars.

Company context:
${companyContext}`,
      },
      {
        role: "user",
        content: `Chat history:\n${contextStr}\n\nHuman says: ${messageText}`,
      },
    ],
  });

  return response.choices[0]?.message?.content ?? "I'll look into that and get back to you.";
}
