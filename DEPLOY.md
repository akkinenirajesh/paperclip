# Paperclip — Primeform Deployment Guide

## Overview

This is the Primeform fork of [Paperclip](https://github.com/paperclipai/paperclip), deployed at **https://paperclip.primeform.in**.

Stack: Docker Compose (Postgres + Server + Telegram Bridge), Nginx, Certbot SSL, Cloudflare DNS.

## Quick Start (Fresh Server)

```bash
# Prerequisites: Docker, Docker Compose, rclone, nginx, certbot, git
git clone git@github.com:akkinenirajesh/paperclip.git
cd paperclip

# Restore from latest backup (pulls from R2, restores DB + config + secrets)
./scripts/restore.sh

# Set up nginx + SSL
sudo cp /tmp/paperclip-nginx.conf /etc/nginx/sites-enabled/paperclip.primeform.in
sudo certbot --nginx -d paperclip.primeform.in
sudo systemctl reload nginx

# Mount Claude credentials (for Claude subscription agents)
# Copy ~/.claude/.credentials.json from a machine where `claude login` was run
```

## Services

| Service | Port | Description |
|---------|------|-------------|
| `db` | 5432 (internal) | Postgres 17 |
| `server` | 3100 | Paperclip server + UI |
| `telegram-bridge` | — | Telegram bot `@primeform_labs_bot` |

## Environment Variables (.env)

| Variable | Required | Description |
|----------|----------|-------------|
| `BETTER_AUTH_SECRET` | Yes | Auth session signing key |
| `PAPERCLIP_AGENT_JWT_SECRET` | Yes | JWT for agent API authentication |
| `PAPERCLIP_PUBLIC_URL` | Yes | `https://paperclip.primeform.in` |
| `OPENROUTER_API_KEY` | Yes | OpenRouter for multi-model AI access |
| `TELEGRAM_BOT_TOKEN` | Yes | Telegram bot token from @BotFather |

## Docker Commands

```bash
# Start everything
docker compose up -d

# Rebuild after code changes
docker compose up -d --build

# Rebuild a single service
docker compose up -d --build telegram-bridge

# View logs
docker compose logs server --tail 50
docker compose logs telegram-bridge --tail 50

# Restart
docker compose restart server
```

## Backups

Backups run automatically via cron every 6 hours and upload to Cloudflare R2.

**What's backed up:**
- Postgres database dump (~67MB)
- Instance config (config.json, secrets, workspace metadata)
- `.env` file (all secrets)

**What's NOT backed up (not needed):**
- npm cache (~1GB, regenerated automatically)
- Docker images (rebuilt from source)
- Nginx config / SSL certs (recreated via certbot)

**Storage:** `r2:v2c/paperclip-backups/` on Cloudflare R2

**Retention:** 7 days of timestamped backups + a `paperclip-latest.tar.gz`

### Manual backup
```bash
./scripts/backup.sh
```

### Cron schedule
```
0 */6 * * * /home/rajesh/dev/paperclip/scripts/backup.sh >> /var/log/paperclip-backup.log 2>&1
```

### Restore from backup
```bash
# Restore latest backup
./scripts/restore.sh

# Restore a specific local backup file
./scripts/restore.sh /path/to/paperclip-20260319-144436.tar.gz
```

## Telegram Bot (@primeform_labs_bot)

The bot bridges human team members with AI agents via Telegram.

### Setup for new users
1. Message the bot — first user becomes **board admin**
2. `/companies` — list companies
3. `/link <company_id>` — link to a company (auto-links if only one)
4. Send messages — AI routes them to issues/comments

### Whitelisting
- `/whitelist <chat_id> <role>` — add a user (board or member)
- `/revoke <chat_id>` — remove a user
- `/members` — list all users

### How messages are routed
| Message type | Action |
|---|---|
| Task, request, update, report | Creates a **Paperclip issue** assigned to the right agent |
| Follow-up to recent issue | Adds a **comment** to the existing issue |
| Approval response | **Approves/rejects** via inline buttons |
| Status question | Fetches agents/issues and responds |
| Greeting (hi, ok, thanks) | General AI response |

### Notifications (Paperclip → Telegram)
- Agent comments on issues → notified to linked users
- Approval requests → notified to board members with Approve/Reject buttons

## Dockerfile Fix

The upstream `master` has a build error — `@paperclipai/plugin-sdk` is referenced but not wired into the Docker build. Our fork fixes this in the `Dockerfile`:
- Added `COPY packages/plugins/sdk/package.json` to the deps stage
- Added `RUN pnpm --filter @paperclipai/plugin-sdk build` before the server build

## Key Files

| File | Purpose |
|------|---------|
| `docker-compose.yml` | All services, env vars, volume mounts |
| `.env` | Secrets (not committed) |
| `Dockerfile` | Server build (with plugin-sdk fix) |
| `services/telegram-bridge/` | Telegram bot service |
| `scripts/backup.sh` | Automated R2 backup |
| `scripts/restore.sh` | Full restore from R2 |
