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
# mozc_dict.db has no build script in this repo and must be present in the
# build context (kept out of .dockerignore for that reason).
COPY --from=dict-builder /build/jmdict.db /build/dict_fts.db ./

EXPOSE 3000
CMD ["sh", "-c", "python segmenter_server.py & exec bun run index.ts"]
