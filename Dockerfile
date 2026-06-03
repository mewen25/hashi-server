# ---------- builder: regenerates jmdict.db and dict_fts.db ----------
FROM oven/bun:1.2.20 AS dict-builder

WORKDIR /build

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY build_dict.ts create_fts.ts ./
# build_dict.ts fetches JMdict_e.gz from ftp.edrdg.org if not present,
# decompresses it, and writes jmdict.db. create_fts.ts then derives
# dict_fts.db from jmdict.db.
RUN bun run build_dict.ts \
    && bun run create_fts.ts \
    && rm -f JMdict_e.gz JMdict_e.xml

# ---------- runtime: python + bun, both servers ----------
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    BUN_INSTALL=/usr/local \
    PATH=/usr/local/bin:$PATH

RUN apt-get update && apt-get install -y --no-install-recommends \
        curl ca-certificates unzip \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://bun.sh/install | bash -s "bun-v1.2.20"

WORKDIR /app

RUN pip install --no-cache-dir sudachipy sudachidict-core

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY . .

# Overwrite any stray local copies with the freshly regenerated dbs.
COPY --from=dict-builder /build/jmdict.db /build/dict_fts.db ./

# mozc_dict.db (85M, read-only) has no build script, so it is fetched from
# object storage at build time. ime.ts opens it at module load — if it is
# missing the server crashes on boot. Set MOZC_DB_URL to the R2 object URL
# (Railway exposes service variables as build args automatically).
ARG MOZC_DB_URL=""
RUN if [ -n "$MOZC_DB_URL" ]; then \
        echo "Fetching mozc_dict.db from $MOZC_DB_URL" \
        && curl -fsSL "$MOZC_DB_URL" -o /app/mozc_dict.db; \
    else \
        echo "WARNING: MOZC_DB_URL not set — mozc_dict.db will be missing and the server will crash on boot" >&2; \
    fi

# Audio, SVG, and jp_sounds assets are served from R2.
# Set this to your R2 public bucket URL (e.g. https://pub-<hash>.r2.dev).
ENV ASSETS_BASE_URL=""

EXPOSE 3000
# start.sh seeds the writable SQLite DBs into the persistent volume on first
# boot, then launches the segmenter sidecar and the bun server.
CMD ["sh", "/app/scripts/start.sh"]
