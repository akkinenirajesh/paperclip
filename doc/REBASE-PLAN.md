# Rebase Plan: Sync Fork with Upstream

**Date:** 2026-03-27
**Fork:** akkinenirajesh/paperclip (origin)
**Upstream:** paperclipai/paperclip (upstream)
**Fork point:** f598a556 (Merge PR #1166 — fix/canary-version-after-partial-publish)

---

## 1. Fork Summary

### Our Commits (13 commits, 29 files, ~2,236 lines added)

| Commit | Description |
|--------|-------------|
| `03ca4e2c` | feat: add Telegram bridge service and fix Docker build |
| `de1303a2` | fix: telegram bridge - direct DB ops, AI-driven agent assignment, typing indicator |
| `c520d371` | fix: stop duplicate telegram notifications, cursor precision fix |
| `6905968b` | feat: add R2 backup and single-script restore |
| `68a2373c` | docs: add DEPLOY.md with full deployment, backup, and telegram guide |
| `0749efa0` | fix: better reply detection and agent question forwarding |
| `11d5abf5` | fix: correct Paperclip UI URLs and improve status_query handling |
| `01eb14c6` | fix: Telegram approval buttons (64 byte callback data limit) |
| `694d2293` | fix: approval notifications and actions via direct DB |
| `c1cc1df6` | feat: auto-recover Claude auth and alert via Telegram |
| `0226b5a5` | fix: mount .claude directory instead of single file |
| `02a0f937` | feat: show real user names in UI, add /tasks command and inbox banner |
| `422795b9` | docs: instruct agents to reassign blocked issues to board operator |

### Our Changes by Category

**New files (no conflict risk):**
- `services/telegram-bridge/` — entire telegram bridge service (8 files)
- `DEPLOY.md` — deployment guide
- `scripts/backup.sh`, `scripts/restore.sh`, `scripts/check-claude-auth.sh`
- `doc/TELEGRAM_MERGE_PLAN.md`
- `packages/db/src/schema/telegram_*.ts` (4 schema files)

**Modified files overlapping with upstream (conflict risk):**
- `Dockerfile` — we added telegram-bridge build stage; upstream added patches copy
- `server/src/routes/access.ts` — upstream added ~192 lines
- `server/src/services/access.ts` — upstream added ~112 lines
- `ui/src/api/access.ts` — both touched
- `ui/src/components/IssueProperties.tsx` — upstream heavily reworked (191 lines)
- `ui/src/components/IssuesList.tsx` — upstream changed 123 lines
- `ui/src/lib/assignees.ts` — small file
- `ui/src/lib/assignees.test.ts` — small file
- `ui/src/lib/queryKeys.ts` — small file
- `ui/src/pages/Dashboard.tsx` — small changes both sides
- `ui/src/pages/Inbox.tsx` — both added content

**Modified files NOT changed upstream (clean replay):**
- `docker-compose.yml`
- `docs/guides/agent-developer/heartbeat-protocol.md`
- `ui/src/components/ActivityRow.tsx`
- `ui/src/pages/Activity.tsx`

---

## 2. Upstream Changes Since Fork (391 commits, 415 files, ~122K lines)

### Major New Features

#### 2.1 Routines System
- Recurring task automation with schedule-based issue creation
- New schema: `routines`, `routine_triggers`, `routine_runs` (migration 0039)
- Server: `services/routines.ts` (1268 LOC), `routes/routines.ts` (299 LOC)
- UI: `pages/Routines.tsx` (661 LOC), `components/ScheduleEditor.tsx` (344 LOC)
- Beta-flagged with portability support

#### 2.2 Company Skills Library
- Company-scoped skills system for agents
- New schema: `company_skills` (migration 0042)
- Server: `services/company-skills.ts` (2355 LOC), `routes/company-skills.ts` (283 LOC)
- UI: `pages/CompanySkills.tsx` (1170 LOC)
- Skills imported from GitHub/skills.sh, injected into adapters at runtime

#### 2.3 Company Import/Export Overhaul
- `services/company-portability.ts` grew by ~4000 LOC
- New dedicated UI pages: `CompanyExport.tsx` (1018 LOC), `CompanyImport.tsx` (1354 LOC)
- File-browser UX with rich preview, conflict resolution, rename indicators
- GitHub URL + zip archive import support

#### 2.4 Board CLI Auth
- New schema: `board_api_keys`, `cli_auth_challenges` (migration 0044)
- Server: `services/board-auth.ts` (354 LOC)
- CLI: `client/board-auth.ts` (282 LOC), `commands/client/auth.ts` (113 LOC)
- Browser-based auth flow for CLI access

#### 2.5 Worktree Merge History
- CLI: `commands/worktree-merge-history-lib.ts` (764 LOC)
- Source discovery, project mapping, merge preview
- Document and attachment import from worktrees
- Port collision fixes, provision isolation

#### 2.6 Inbox Improvements
- "Mine" tab with archive flow
- New schema: `issue_inbox_archives` (migration 0045)
- Unread/dismissed for all inbox item types
- Join requests inline, failed runs interleaved
- `SwipeToArchive` component

#### 2.7 Agent Instructions Bundle
- Server: `services/agent-instructions.ts` (735 LOC)
- Default CEO delegation instructions
- Bundled instructions per adapter

#### 2.8 SVG Org Chart Renderer
- Server: `routes/org-chart-svg.ts` (777 LOC)
- Pure SVG, multi-style, Twemoji emoji, no browser needed

#### 2.9 Evals Framework
- Promptfoo eval bootstrap with YAML test cases

### Upstream Schema Changes (Migrations 0038-0045)

| Migration | What it does |
|-----------|-------------|
| **0038** `careless_iron_monger` | Add `process_pid`, `process_started_at`, `retry_of_run_id`, `process_loss_retry_count` to `heartbeat_runs` |
| **0039** `fat_magneto` | Create `routines`, `routine_triggers`, `routine_runs` tables + add `origin_kind`, `origin_id`, `hidden_at`, `execution_run_id` to `issues` |
| **0040** `eager_shotgun` | Add unique index on `issues` for routine execution + unique index on `routine_triggers.public_id` |
| **0041** `curly_maria_hill` | Add `general` jsonb column to `instance_settings` |
| **0042** `spotty_the_renegades` | Create `company_skills` table with indexes |
| **0043** `reflective_captain_universe` | Recreate routine execution unique index (add `execution_run_id` condition) |
| **0044** `illegal_toad` | Create `board_api_keys`, `cli_auth_challenges` tables + idempotent `instance_settings.general` |
| **0045** `workable_shockwave` | Create `issue_inbox_archives` table |

### Our Schema Changes (Migrations 0038-0041)

| Migration | What it does |
|-----------|-------------|
| **0038** `brainy_mole_man` | Add `org_role`, `org_reports_to`, `org_title` to `company_memberships` |
| **0039** `simple_pet_avengers` | Add `org_display_name` to `company_memberships` |
| **0040** `wakeful_domino` | Create `telegram_callback_map`, `telegram_message_map`, `telegram_poll_cursor`, `telegram_user_map` tables |
| **0041** `stiff_bloodscream` | Add `reports_to_user_id` to `agents` |

**No SQL conflicts** — our migrations touch completely different tables than upstream's. The issue is only the numbering collision (both start at 0038).

---

## 3. DB Backup & Migration Strategy

### Pre-Rebase: Backup Current Database

```bash
docker compose exec db pg_dump -U paperclip -d paperclip --clean --if-exists > backup_pre_rebase_$(date +%Y%m%d_%H%M%S).sql
```

### Post-Rebase: Migration Reconciliation

After rebase, upstream migrations 0038-0045 will exist in the codebase. Our migrations need to be renumbered to 0046-0049.

**Critical:** The DB already has our 0038-0041 applied (by hash). Drizzle tracks migrations by hash, not number. So the approach is:

1. After rebase, renumber our migration files to 0046-0049
2. Manually apply upstream migrations 0038-0045 to the existing DB (the SQL is all additive — CREATE TABLE IF NOT EXISTS, ADD COLUMN IF NOT EXISTS)
3. Insert upstream migration hashes into `drizzle.__drizzle_migrations` so Drizzle thinks they're applied
4. Update our migration file numbers and journal entries

Alternatively (simpler):
1. Backup DB
2. After rebase, let Drizzle see the new migration journal
3. Run upstream 0038-0045 SQL manually against the DB (all idempotent)
4. Insert their hashes into the drizzle migrations table
5. Renumber our files to 0046-0049 with updated journal
6. Drizzle will then apply 0046-0049 (which are already applied — the SQL is also idempotent with IF NOT EXISTS)

---

## 4. Rebase Execution Plan

### Step 1: Full backup
```bash
docker compose exec db pg_dump -U paperclip -d paperclip --clean --if-exists > backup_pre_rebase.sql
```

### Step 2: Create safety branch
```bash
git branch pre-rebase-backup master
```

### Step 3: Stash uncommitted changes
```bash
git stash
```

### Step 4: Rebase
```bash
git rebase --onto upstream/master f598a556 master
```

### Step 5: Resolve conflicts (~11 files)
Expect conflicts in:
- `Dockerfile`
- `server/src/routes/access.ts`
- `server/src/services/access.ts`
- `ui/src/api/access.ts`
- `ui/src/components/IssueProperties.tsx`
- `ui/src/components/IssuesList.tsx`
- `ui/src/lib/assignees.ts`
- `ui/src/lib/assignees.test.ts`
- `ui/src/lib/queryKeys.ts`
- `ui/src/pages/Dashboard.tsx`
- `ui/src/pages/Inbox.tsx`

### Step 6: Renumber our migrations
Rename 0038-0041 to 0046-0049, update migration journal

### Step 7: Reconcile DB
Apply upstream migrations 0038-0045 to existing DB, register hashes

### Step 8: Pop stash, rebuild, test
```bash
git stash pop
pnpm install
pnpm build
```

### Step 9: Verify
- Server starts
- UI loads
- Existing data intact
- Telegram bridge works

---

## 5. Uncommitted Work (Currently Staged/Modified)

These files are modified but not committed — they relate to the in-progress telegram server-side integration:

**Schema changes:** `agents.ts`, `company_memberships.ts`, `index.ts`
**Shared:** `constants.ts`, `index.ts`, `types/access.ts`, `types/agent.ts`
**Server:** `index.ts`, `middleware/auth.ts`, routes (`access`, `agents`, `approvals`, `authz`, `instance-settings`), services (`access`, `agents`, `index`), `types/express.d.ts`
**Telegram bridge:** `ai.ts`, `db.ts`, `event-poller.ts`
**UI:** `api/access.ts`, `api/agents.ts`, `components/IssuesList.tsx`, `components/NewAgentDialog.tsx`, pages (`Agents`, `IssueDetail`, `NewAgent`, `OrgChart`)
**Infra:** `Dockerfile`, `docker-compose.yml`, `pnpm-lock.yaml`, `server/package.json`
**New untracked:** `Dockerfile.npm`, `docker-compose.npm.yml`, `server/src/services/telegram/`, telegram schema files, migrations 0038-0041

These need to be stashed before rebase and carefully reapplied after.
