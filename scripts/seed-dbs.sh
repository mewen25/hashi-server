#!/usr/bin/env bash
# One-time migration of the LIVE writable SQLite DBs (cards.db, requests.db)
# to R2, so the Railway volume can seed itself from them on first boot.
#
# Run this once from your local machine BEFORE the first Railway deploy (and
# again only if you ever want to reset the volume's seed snapshot). The WAL is
# checkpointed first so each uploaded .db file is self-contained.
set -euo pipefail

: "${R2_ACCOUNT_ID:?R2_ACCOUNT_ID not set — find it in Cloudflare Dashboard > R2 > Account ID}"
: "${R2_BUCKET:?R2_BUCKET not set — name of the R2 bucket}"
: "${AWS_ACCESS_KEY_ID:?AWS_ACCESS_KEY_ID not set — create an R2 API token}"
: "${AWS_SECRET_ACCESS_KEY:?AWS_SECRET_ACCESS_KEY not set}"

ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"

BIN=""
for candidate in aws aws.exe aws.cmd; do
  if command -v "$candidate" &>/dev/null; then
    BIN="$candidate"
    break
  fi
done
if [ -z "$BIN" ]; then
  echo "error: aws-cli not found — install it from https://aws.amazon.com/cli/"
  exit 1
fi
if ! command -v sqlite3 &>/dev/null; then
  echo "error: sqlite3 not found — needed to checkpoint the WAL before upload"
  exit 1
fi

BASE="$(cd "$(dirname "$0")/.." && pwd)"

for db in cards requests; do
  f="$BASE/$db.db"
  if [ ! -f "$f" ]; then
    echo "skip $db.db (not found at $f)"
    continue
  fi
  echo "Checkpointing $db.db WAL..."
  sqlite3 "$f" "PRAGMA wal_checkpoint(TRUNCATE);" >/dev/null || true
  echo "Uploading $db.db → ${R2_BUCKET}/seed/$db.db"
  "$BIN" s3 cp "$f" "s3://${R2_BUCKET}/seed/$db.db" \
    --endpoint-url "$ENDPOINT" \
    --content-type "application/x-sqlite3" \
    --no-progress
done

echo ""
echo "Done. On the Railway service, set:"
echo "  CARDS_SEED_URL=https://pub-<hash>.r2.dev/seed/cards.db"
echo "  REQUESTS_SEED_URL=https://pub-<hash>.r2.dev/seed/requests.db"
echo "The volume seeds from these only when the target file does not yet exist."
