#!/usr/bin/env bash
set -euo pipefail

# Check Claude OAuth token validity and alert via Telegram if expired/expiring.
# Cron: */30 * * * * /home/rajesh/dev/paperclip/scripts/check-claude-auth.sh

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

set -a
source "$PROJECT_DIR/.env"
set +a

BOT_TOKEN="$TELEGRAM_BOT_TOKEN"
CHAT_ID="${TELEGRAM_ADMIN_CHAT_ID:-81650741}"

# Check auth status
AUTH_JSON=$(claude auth status --json 2>&1 || echo '{"loggedIn":false}')
LOGGED_IN=$(echo "$AUTH_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin).get('loggedIn', False))" 2>/dev/null || echo "False")

if [ "$LOGGED_IN" != "True" ]; then
  echo "[$(date -u)] Claude auth expired!"

  # Alert on Telegram
  curl -s "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
    -d chat_id="$CHAT_ID" \
    -d parse_mode="HTML" \
    -d text="⚠️ <b>Claude OAuth token expired!</b>

AI agents are unable to run. Please refresh the token:

<code>claude login</code>

Then reset agents:
<code>docker exec paperclip-db-1 psql -U paperclip -d paperclip -c \"UPDATE agents SET status = 'idle' WHERE status = 'error';\"</code>" \
    > /dev/null

  # Also check container auth
  CONTAINER_AUTH=$(docker exec paperclip-server-1 claude auth status --json 2>&1 || echo '{"loggedIn":false}')
  CONTAINER_OK=$(echo "$CONTAINER_AUTH" | python3 -c "import sys,json; print(json.load(sys.stdin).get('loggedIn', False))" 2>/dev/null || echo "False")

  if [ "$CONTAINER_OK" = "True" ]; then
    echo "[$(date -u)] Container has valid auth but host doesn't — unusual"
  fi
else
  # Check if agents are stuck in error state (token may have just been refreshed)
  ERROR_AGENTS=$(docker exec paperclip-db-1 psql -U paperclip -d paperclip -t -c "SELECT count(*) FROM agents WHERE status = 'error';" 2>/dev/null | tr -d ' ')

  if [ "${ERROR_AGENTS:-0}" -gt 0 ]; then
    echo "[$(date -u)] Auth OK but $ERROR_AGENTS agents in error state — auto-recovering"

    # Reset agents and queue heartbeats
    docker exec paperclip-db-1 psql -U paperclip -d paperclip -c "
      UPDATE agents SET status = 'idle', updated_at = NOW() WHERE status = 'error';
      INSERT INTO heartbeat_runs (company_id, agent_id, invocation_source, status, trigger_detail)
      SELECT company_id, id, 'on_demand', 'queued', 'auth_recovery'
      FROM agents WHERE status = 'idle';
    " > /dev/null 2>&1

    curl -s "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
      -d chat_id="$CHAT_ID" \
      -d parse_mode="HTML" \
      -d text="🔄 <b>Auto-recovered ${ERROR_AGENTS} agents</b>

Claude auth is valid. Agents were stuck in error state (likely from a previous token expiry). Reset to idle and queued heartbeats." \
      > /dev/null
  fi
fi
