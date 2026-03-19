#!/usr/bin/env bash
set -euo pipefail

# Paperclip Restore Script — full restore from R2 backup to a fresh server
# This is the single script to get Paperclip running from scratch.
#
# Prerequisites on the new server:
#   - Docker + Docker Compose
#   - rclone
#   - git
#   - nginx + certbot (optional, for HTTPS)
#
# Usage:
#   git clone git@github.com:akkinenirajesh/paperclip.git
#   cd paperclip
#   ./scripts/restore.sh [backup-file]
#
# If no backup-file specified, downloads the latest backup from R2.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# R2 config — set these or they default to Primeform R2
R2_ENDPOINT="${R2_ENDPOINT:-https://f9c775422a33eba16dd6c14bd1538362.r2.cloudflarestorage.com}"
R2_ACCESS_KEY="${R2_ACCESS_KEY:-95d5bfc0584efd68c568d7f0cf75cb13}"
R2_SECRET_KEY="${R2_SECRET_KEY:-67915d6892eab435baa845c7256c5489b9cc197f415b1ddd0640f3424d13cd96}"
R2_BUCKET="${R2_BUCKET:-v2c}"
R2_PATH="${R2_PATH:-paperclip-backups}"

RESTORE_DIR=$(mktemp -d)
trap 'rm -rf "$RESTORE_DIR"' EXIT

# Create temporary rclone config
export RCLONE_CONFIG="$RESTORE_DIR/rclone.conf"
cat > "$RCLONE_CONFIG" <<RCLONE
[r2]
type = s3
provider = Cloudflare
access_key_id = $R2_ACCESS_KEY
secret_access_key = $R2_SECRET_KEY
endpoint = $R2_ENDPOINT
acl = private
no_check_bucket = true
RCLONE

# 1. Download backup
BACKUP_FILE="${1:-}"
if [[ -z "$BACKUP_FILE" ]]; then
  echo "[$(date -u)] Downloading latest backup from R2..."
  BACKUP_FILE="$RESTORE_DIR/paperclip-latest.tar.gz"
  rclone copyto "r2:$R2_BUCKET/$R2_PATH/paperclip-latest.tar.gz" "$BACKUP_FILE"
else
  echo "[$(date -u)] Using local backup: $BACKUP_FILE"
fi

# 2. Extract
echo "[$(date -u)] Extracting backup..."
tar xzf "$BACKUP_FILE" -C "$RESTORE_DIR"

# 3. Restore .env
echo "[$(date -u)] Restoring .env..."
if [[ -f "$RESTORE_DIR/dot-env" ]]; then
  cp "$RESTORE_DIR/dot-env" "$PROJECT_DIR/.env"
  echo "  .env restored"
else
  echo "  WARNING: No .env in backup. You'll need to create one manually."
fi

# 4. Start only the database
echo "[$(date -u)] Starting database..."
docker compose -f "$PROJECT_DIR/docker-compose.yml" up -d db
echo "  Waiting for database to be healthy..."
until docker exec paperclip-db-1 pg_isready -U paperclip -d paperclip 2>/dev/null; do
  sleep 1
done

# 5. Restore Postgres dump
echo "[$(date -u)] Restoring Postgres..."
docker exec paperclip-db-1 dropdb -U paperclip --if-exists paperclip
docker exec paperclip-db-1 createdb -U paperclip paperclip
docker exec -i paperclip-db-1 pg_restore -U paperclip -d paperclip --no-owner --no-acl \
  < "$RESTORE_DIR/postgres.dump"
echo "  Postgres restored"

# 6. Restore instance config
echo "[$(date -u)] Restoring instance config..."
VOLUME_PATH=$(docker volume inspect paperclip_paperclip-data --format '{{.Mountpoint}}')
if [[ -d "$RESTORE_DIR/instances" ]]; then
  sudo mkdir -p "$VOLUME_PATH/instances"
  sudo cp -a "$RESTORE_DIR/instances/." "$VOLUME_PATH/instances/"
  sudo chown -R 1000:1000 "$VOLUME_PATH/instances"
  echo "  Instance config restored"
fi

# 7. Start all services
echo "[$(date -u)] Starting all services..."
docker compose -f "$PROJECT_DIR/docker-compose.yml" up -d --build

# 8. Wait for server
echo "[$(date -u)] Waiting for server to be ready..."
for i in $(seq 1 60); do
  if curl -sf http://localhost:3100/api/health > /dev/null 2>&1; then
    echo "  Server is up!"
    break
  fi
  sleep 2
done

echo ""
echo "============================================"
echo "  Paperclip restore complete!"
echo "============================================"
echo ""
echo "  URL: $(grep PAPERCLIP_PUBLIC_URL "$PROJECT_DIR/.env" 2>/dev/null | cut -d= -f2 || echo 'http://localhost:3100')"
echo ""
echo "  Next steps:"
echo "  1. Set up nginx reverse proxy (if on a new server)"
echo "  2. Run: sudo certbot --nginx -d paperclip.primeform.in"
echo "  3. Mount Claude credentials if using Claude subscription"
echo "  4. Verify at the URL above"
echo ""
