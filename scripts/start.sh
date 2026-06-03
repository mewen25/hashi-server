#!/bin/sh
# Container entrypoint.
#
# 1. Seeds the writable SQLite DBs (cards.db, requests.db) into the persistent
#    Railway volume on FIRST boot only. An existing file is never overwritten,
#    so live data survives redeploys/restarts. Seeding is skipped entirely if
#    the corresponding *_SEED_URL is unset (DB is then created fresh by the app).
# 2. Ensures the pronunciation log directory exists.
# 3. Launches the Python segmenter sidecar (127.0.0.1:7331) and the bun server.
set -eu

seed_db() {
  target="$1"
  url="$2"
  if [ -z "$url" ]; then
    return 0
  fi
  if [ -f "$target" ]; then
    echo "[seed] $target already exists — skipping"
    return 0
  fi
  mkdir -p "$(dirname "$target")"
  echo "[seed] downloading $url -> $target"
  curl -fsSL "$url" -o "$target"
}

seed_db "${CARDS_DB_PATH:-cards.db}" "${CARDS_SEED_URL:-}"
seed_db "${REQUESTS_DB_PATH:-requests.db}" "${REQUESTS_SEED_URL:-}"

# index.ts opens the pronunciation log writer at module load; make sure its
# directory (e.g. on the volume) exists first.
if [ -n "${PRONUNCIATION_LOG:-}" ]; then
  mkdir -p "$(dirname "$PRONUNCIATION_LOG")"
fi

python segmenter_server.py &
exec bun run index.ts
