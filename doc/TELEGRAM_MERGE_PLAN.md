# Plan: Merge Telegram Bridge into Paperclip Server + Multi-Turn Agency

## Context

The Telegram bridge is a separate Docker container that does stateless classify-and-respond. It uses OpenRouter for LLM calls and has no memory across turns. Problems:

- Every message gets hardcoded into "create issue" or "add comment" — no intelligence
- No multi-turn ability — can't interview a user, follow up, or run multi-step workflows
- Separate container with its own LLM dependency (OpenRouter)
- Not a real agent — just a router

## Vision

The Telegram agent is an **invisible, autonomous conversational agent** — the company's communication interface. It:

- **Understands context** — remembers what was discussed, doesn't re-ask
- **Decides what to do via tools** — not hardcoded routes. It calls `create_issue`, `add_comment`, `list_issues`, `approve`, `relay_to_agent` etc. as needed
- **Runs multi-step tasks** — e.g., an AI agent assigns "gather BOM specs" to a human → the Telegram agent interviews the user over multiple turns → posts structured answers back
- **Is invisible** — not in the agent list, not in the org chart. It's a system service, not a company employee
- **Uses Claude subscription** — runs via claude_local adapter, no OpenRouter

## Architecture

```
Telegram User
    ↕ (grammy long-poll inside server process)
Telegram Conversational Agent (server/src/services/telegram/)
    ↕
    ├── Inbound: message → add to conversation → Claude thinks → calls tools as needed
    ├── Tools: create_issue, comment, list_issues, approve, relay_to_agent, ask_user, etc.
    ├── Session: persistent per-chat via agent_task_sessions (--resume)
    ├── Streaming: heartbeat_run_events → editMessageText in Telegram
    ├── Multi-step: agent can ask follow-ups before taking action
    └── Outbound: live-events → notifications (approvals, agent questions, assignments)
```

The agent has a **system prompt** that describes the company, available tools, and its role as the communication interface. It is NOT a visible agent in the company — it's infrastructure.

---

## Phases

### Phase 1: Schema Migration

Move the 4 telegram tables from raw SQL into drizzle schema.

**Create:**
| File | Table |
|------|-------|
| `packages/db/src/schema/telegram_user_map.ts` | `telegram_user_map` — FK to companies |
| `packages/db/src/schema/telegram_message_map.ts` | `telegram_message_map` — add `agent_task_session_id` FK |
| `packages/db/src/schema/telegram_callback_map.ts` | `telegram_callback_map` |
| `packages/db/src/schema/telegram_poll_cursor.ts` | `telegram_poll_cursor` |

**Modify:**
- `packages/db/src/schema/index.ts` — export new tables
- Generate migration with `pnpm db:generate` (must be safe against existing tables)

### Phase 2: Telegram Service in Server + Tool Definitions

Replace the separate container with an in-process conversational agent.

**Create:**
| File | Purpose |
|------|---------|
| `server/src/services/telegram/index.ts` | Service entry: `createTelegramService(db, heartbeat, bot)`, returns `{ start(), stop() }` |
| `server/src/services/telegram/bot.ts` | grammy Bot creation, long-poll start/stop, graceful shutdown |
| `server/src/services/telegram/handlers.ts` | Minimal routing: `/commands` go direct, everything else → conversational agent |
| `server/src/services/telegram/queries.ts` | Drizzle data access: getUser, saveMessageMap, getRecentChatContext, etc. |
| `server/src/services/telegram/tools.ts` | Tool definitions the agent can call (see below) |
| `server/src/services/telegram/system-prompt.ts` | Builds the system prompt with company context, available tools, user info |
| `server/src/services/telegram/types.ts` | Shared types |

**Modify:**
- `server/src/index.ts` — init telegram service after server starts (only if `TELEGRAM_BOT_TOKEN` is set)
- `server/src/services/index.ts` — export telegram service
- `server/package.json` — add `grammy` dependency

**The agent is NOT in the agents table.** It's a system-level service with its own session, not a company employee. It doesn't appear in the agent list or org chart.

**Tool definitions** (`tools.ts`) — the agent decides what to do by calling tools:
| Tool | Purpose |
|------|---------|
| `create_issue` | Create a new issue in Paperclip (with title, description, assignee) |
| `add_comment` | Add a comment to an existing issue |
| `list_my_issues` | List issues assigned to the current user |
| `get_issue_details` | Get full details of an issue (comments, status, assignee) |
| `approve_request` | Approve a pending approval |
| `reject_request` | Reject a pending approval |
| `list_pending_approvals` | List approvals waiting for board action |
| `relay_to_agent` | Send a message/task to a specific agent (CEO, COO, etc.) |
| `ask_user` | Ask the user a follow-up question (returns control to wait for response) |
| `get_company_status` | Dashboard summary — agents, issues, recent activity |
| `list_agents` | List company agents and their statuses |

The agent has NO hardcoded routing. Its system prompt says:
> "You are the communication interface for {company}. The user is {name} ({role}). You have tools to interact with the company. Understand what the user needs and take appropriate action. If you need more information, ask follow-up questions before acting. You can run multi-step workflows — e.g., interview the user about an issue, then create it with full details."

### Phase 3: Multi-Turn Conversation Sessions

Wire Telegram chats to persistent Claude sessions.

**Create:**
- `server/src/services/telegram/session-manager.ts` — Maps `chatId` → Claude session

**Flow:**
1. User sends message in chat `12345`
2. Handler appends message to conversation history
3. Invokes Claude via claude_local adapter with `--resume {sessionId}` + tools
4. Claude decides what to do:
   - Needs more info? → calls `ask_user` tool → response sent to Telegram → waits for next message
   - Ready to act? → calls `create_issue`, `add_comment`, `relay_to_agent`, etc.
   - Multi-step? → calls multiple tools in sequence (e.g., `get_issue_details` → asks user questions → `add_comment` with answers)
5. Final text response → sent to Telegram
6. Session persisted in `agent_task_sessions` with `taskKey: 'telegram:chat:12345'`
7. Session rotation handled automatically by existing `evaluateSessionCompaction`

**Multi-step interview example:**
```
CEO assigns PRI-42 "Gather BOM specs" to Rajesh
  → Telegram agent gets notified (issue assigned to human)
  → Agent sends: "Hey Rajesh, you've been assigned PRI-42: Gather BOM specs.
     I need some details:
     1. What material are you using for the chamber walls?
     2. What's the target wall thickness?"
  → Rajesh replies: "SS304, 3mm"
  → Agent calls get_issue_details(PRI-42), then add_comment(PRI-42, "BOM specs from Rajesh: SS304, 3mm wall thickness")
  → Agent: "Got it. The COO also needs the seal material — EPDM or silicone?"
  → Rajesh: "Silicone"
  → Agent calls add_comment(PRI-42, "Seal material: Silicone per Rajesh")
  → Agent: "All noted on PRI-42. I've updated the issue."
```

### Phase 4: Streaming Responses

Show partial responses in Telegram as the agent thinks.

**Create:**
- `server/src/services/telegram/streaming.ts` — Watches active runs, pipes output to Telegram

**Pattern (inspired by OpenClaw lane delivery):**
1. After invoke, track `{ chatId, runId, sentMessageId: null }`
2. Subscribe to live events for the company
3. On run start → `sendChatAction(chatId, 'typing')`
4. First text chunk → `sendMessage(chatId, chunk)` → store message ID
5. Subsequent chunks → `editMessageText(chatId, msgId, accumulated)` (throttled 300ms)
6. On run finish → send final complete message
7. Messages >4096 chars → split into multiple messages
8. Convert markdown → Telegram HTML
9. Tool calls → optionally show "Working on it..." or silent

### Phase 5: Proactive Outreach

The agent doesn't just respond — it initiates conversations.

**Create:**
- `server/src/services/telegram/notifications.ts` — subscribes to `subscribeCompanyLiveEvents()`

**When an issue is assigned to a human:**
- Agent doesn't just notify — it starts a conversation
- Reads the issue details, understands what's needed
- Proactively asks the user relevant questions
- This is an `ask_user` tool call initiated by the system, not the user

**When an agent posts a question on an issue assigned to a human:**
- Agent reads the question, reformulates it conversationally
- Starts a multi-turn interview if needed

**Approval notifications:**
- Still use inline keyboard buttons for quick approve/reject
- But the agent can also explain the approval context conversationally

**Keep:** Safety-net poll (60s) + 8h digest loop.

### Phase 6: Remove Bridge Container

**Delete:**
- `services/telegram-bridge/` (entire directory)

**Modify:**
- `docker-compose.yml` — remove `telegram-bridge` service, add `TELEGRAM_BOT_TOKEN` to server env
- `.env` docs — update

---

## Files Summary

| Phase | Create | Modify |
|-------|--------|--------|
| 1 | 4 schema files | `schema/index.ts`, migration |
| 2 | 7 service files | `server/index.ts`, `services/index.ts`, `package.json` |
| 3 | 1 session manager | — |
| 4 | 1 streaming file | — |
| 5 | 1 notifications file | — |
| 6 | — | `docker-compose.yml`, delete `services/telegram-bridge/` |

**Total: ~14 new files, ~5 modified files, 1 directory deleted**

---

## Key Design Principles

1. **No hardcoded routing** — the agent decides via tools, not if/else chains
2. **Invisible agent** — not in agents table, not in org chart, system infrastructure
3. **Conversational first** — ask follow-ups before acting, don't assume
4. **Multi-step capable** — can interview users, gather info across turns, then act
5. **Proactive** — initiates conversations when issues are assigned, not just responds
6. **Tool-driven** — every action (create issue, comment, approve) is a tool call the agent chooses

---

## Migration Strategy

1. Gate new service behind `TELEGRAM_BRIDGE_MODE=integrated|legacy` (default `legacy`)
2. Run both during testing — old bridge container + new server service
3. Cut over by setting `TELEGRAM_BRIDGE_MODE=integrated` and stopping the bridge container
4. Remove bridge container in Phase 6

---

## Verification

1. `pnpm -r typecheck` — all packages compile
2. `pnpm test:run` — existing tests pass
3. Docker rebuild with `TELEGRAM_BOT_TOKEN` in server env
4. Send "hi" → agent responds conversationally (no issue created)
5. Send "deploy to production" → agent asks follow-up questions → then creates issue
6. Agent assigns issue to you → Telegram agent interviews you about it
7. Reply across multiple turns → agent remembers full context
8. Agent streams response (typing indicator → partial text → final)
9. Approval notification → approve via button → agent confirms
10. Server restart → conversation resumes where it left off
11. Agent is NOT visible in /agents list or org chart

---

## Open Questions (to refine over time)

- Should the telegram agent have its own Claude session, or share session with an existing agent (e.g., CEO)?
- How to handle group chats vs DMs?
- Should the agent's tool calls be auditable (logged as activity)?
- Rate limiting: what if user sends 20 messages while agent is still thinking?
- Should the agent be able to create agents or only relay to CEO for that?
