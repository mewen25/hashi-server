#!/usr/bin/env bash
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

BASE="$(cd "$(dirname "$0")/.." && pwd)"

echo "Uploading svg/ (181M, ~6000 files) → ${R2_BUCKET}/svg/"
"$BIN" s3 sync "$BASE/svg" "s3://${R2_BUCKET}/svg" \
  --endpoint-url "$ENDPOINT" \
  --content-type "image/svg+xml" \
  --size-only \
  --no-progress

echo "Uploading audio/ (389M, ~5400 files) → ${R2_BUCKET}/audio/"
"$BIN" s3 sync "$BASE/audio" "s3://${R2_BUCKET}/audio" \
  --endpoint-url "$ENDPOINT" \
  --content-type "audio/wav" \
  --size-only \
  --no-progress

echo "Uploading jp_sounds/ (39M, ~5400 files) → ${R2_BUCKET}/jp_sounds/"
"$BIN" s3 sync "$BASE/jp_sounds" "s3://${R2_BUCKET}/jp_sounds" \
  --endpoint-url "$ENDPOINT" \
  --content-type "audio/mpeg" \
  --size-only \
  --no-progress

if [ -f "$BASE/mozc_dict.db" ]; then
  echo "Uploading mozc_dict.db (85M) → ${R2_BUCKET}/mozc_dict.db"
  "$BIN" s3 cp "$BASE/mozc_dict.db" "s3://${R2_BUCKET}/mozc_dict.db" \
    --endpoint-url "$ENDPOINT" \
    --content-type "application/x-sqlite3" \
    --no-progress
else
  echo "skip mozc_dict.db (not found at $BASE/mozc_dict.db)"
fi

echo ""
echo "Done."
echo "  - Set ASSETS_BASE_URL=https://pub-<hash>.r2.dev/ (or your custom domain) on the server."
echo "  - Set MOZC_DB_URL=https://pub-<hash>.r2.dev/mozc_dict.db as a Railway build variable."
