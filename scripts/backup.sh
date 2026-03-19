#!/usr/bin/env bash
set -euo pipefail

# Paperclip Backup Script — backs up Postgres + config to Cloudflare R2
# All config via env vars. No dependency on user home.
# Usage: ./scripts/backup.sh
# Cron:  0 */6 * * * cd /home/rajesh/dev/paperclip && ./scripts/backup.sh >> /var/log/paperclip-backup.log 2>&1

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Load env
set -a
source "$PROJECT_DIR/.env"
set +a

# R2 config (override via env or defaults to these)
R2_ENDPOINT="${R2_ENDPOINT:-https://f9c775422a33eba16dd6c14bd1538362.r2.cloudflarestorage.com}"
R2_ACCESS_KEY="${R2_ACCESS_KEY:-95d5bfc0584efd68c568d7f0cf75cb13}"
R2_SECRET_KEY="${R2_SECRET_KEY:-67915d6892eab435baa845c7256c5489b9cc197f415b1ddd0640f3424d13cd96}"
R2_BUCKET="${R2_BUCKET:-v2c}"
R2_PATH="${R2_PATH:-paperclip-backups}"

TIMESTAMP=$(date -u +%Y%m%d-%H%M%S)
BACKUP_DIR=$(mktemp -d)
trap 'rm -rf "$BACKUP_DIR"' EXIT

echo "[$(date -u)] Starting Paperclip backup..."

# 1. Dump Postgres
echo "[$(date -u)] Dumping Postgres..."
docker exec paperclip-db-1 pg_dump -U paperclip -d paperclip --format=custom \
  > "$BACKUP_DIR/postgres.dump"

# 2. Copy config (instances dir — config.json, secrets, workspaces metadata)
echo "[$(date -u)] Copying instance config..."
docker cp paperclip-server-1:/paperclip/instances "$BACKUP_DIR/instances"

# 3. Copy .env (secrets)
cp "$PROJECT_DIR/.env" "$BACKUP_DIR/dot-env"

# 4. Create tarball (exclude node_modules, .npm, .cache, logs, large workspaces)
echo "[$(date -u)] Creating tarball..."
tar czf "$BACKUP_DIR/paperclip-$TIMESTAMP.tar.gz" \
  -C "$BACKUP_DIR" \
  postgres.dump \
  instances \
  dot-env

# 5. Upload to R2
echo "[$(date -u)] Uploading to R2..."
export RCLONE_CONFIG="$BACKUP_DIR/rclone.conf"
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

rclone copyto "$BACKUP_DIR/paperclip-$TIMESTAMP.tar.gz" \
  "r2:$R2_BUCKET/$R2_PATH/paperclip-$TIMESTAMP.tar.gz"

# Also maintain a "latest" pointer
rclone copyto "$BACKUP_DIR/paperclip-$TIMESTAMP.tar.gz" \
  "r2:$R2_BUCKET/$R2_PATH/paperclip-latest.tar.gz"

# 6. Prune old backups (keep last 7 days)
echo "[$(date -u)] Pruning old backups..."
CUTOFF=$(date -u -d '7 days ago' +%Y%m%d)
rclone lsf "r2:$R2_BUCKET/$R2_PATH/" --files-only | while read -r file; do
  # Extract date from filename: paperclip-YYYYMMDD-HHMMSS.tar.gz
  FILE_DATE=$(echo "$file" | grep -oP '\d{8}' | head -1)
  if [[ -n "$FILE_DATE" && "$FILE_DATE" < "$CUTOFF" ]]; then
    echo "  Deleting old backup: $file"
    rclone delete "r2:$R2_BUCKET/$R2_PATH/$file"
  fi
done

SIZE=$(du -sh "$BACKUP_DIR/paperclip-$TIMESTAMP.tar.gz" | cut -f1)
echo "[$(date -u)] Backup complete: paperclip-$TIMESTAMP.tar.gz ($SIZE)"
