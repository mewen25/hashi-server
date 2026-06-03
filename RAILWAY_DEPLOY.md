# Railway Deployment

This service deploys to Railway from the `Dockerfile`. It runs two processes in
one container: the Python segmenter sidecar (`127.0.0.1:7331`) and the Bun HTTP
server (`$PORT`). Railway is pinned to the Dockerfile builder and probes
`/health` via `railway.json`.

## Data strategy

Large files are never committed to git. Each category is handled differently:

| Data | Size | How it gets to the container |
|------|------|------------------------------|
| `jmdict.db`, `dict_fts.db` | 46M | Regenerated at build time (`build_dict.ts` → `create_fts.ts`) |
| `mozc_dict.db` | 85M | Fetched from R2 at build time via the `MOZC_DB_URL` build arg |
| `jp_sounds`, `audio`, `svg` | 600M+ | Served from R2 at runtime via `ASSETS_BASE_URL` (`assets.ts`) |
| `cards.db`, `requests.db` | runtime | Persistent Railway **volume**, seeded from R2 on first boot |
| `pronunciation.log.jsonl` | runtime | Persistent volume |

## One-time setup

1. **Upload read-only assets + the mozc dict to R2** (from your machine):
   ```sh
   export R2_ACCOUNT_ID=... R2_BUCKET=... AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=...
   ./scripts/upload-assets.sh
   ```
   This pushes `svg/`, `audio/`, `jp_sounds/`, and `mozc_dict.db`.

2. **Seed your live writable DBs to R2** (only if you have existing data to keep):
   ```sh
   ./scripts/seed-dbs.sh
   ```
   Checkpoints the WAL and uploads `cards.db`/`requests.db` to `seed/` in the bucket.

3. **Create a Railway volume** on the service, mounted at `/data`.

## Railway configuration

### Service variables (runtime)

| Variable | Value | Notes |
|----------|-------|-------|
| `DEEPL_KEY` | *(secret)* | **Boot-critical** — `translate.ts` builds the DeepL client at module load |
| `DEEPSEEK_KEY` | *(secret)* | Required when `/api/analyse` is called |
| `ASSETS_BASE_URL` | `https://pub-<hash>.r2.dev` | R2 public URL for media |
| `CARDS_DB_PATH` | `/data/cards.db` | On the volume |
| `REQUESTS_DB_PATH` | `/data/requests.db` | On the volume |
| `PRONUNCIATION_LOG` | `/data/pronunciation.log.jsonl` | On the volume |
| `CARDS_SEED_URL` | `https://pub-<hash>.r2.dev/seed/cards.db` | First-boot seed only |
| `REQUESTS_SEED_URL` | `https://pub-<hash>.r2.dev/seed/requests.db` | First-boot seed only |

`PORT` is injected by Railway. `MOZC_DB_PATH` is left unset (defaults to the
build-fetched `./mozc_dict.db`).

### Build variable

| Variable | Value |
|----------|-------|
| `MOZC_DB_URL` | `https://pub-<hash>.r2.dev/mozc_dict.db` |

Railway exposes service variables as Docker build args automatically, so the
`ARG MOZC_DB_URL` in the Dockerfile picks this up.

## How first-boot seeding works

`scripts/start.sh` downloads `CARDS_SEED_URL`/`REQUESTS_SEED_URL` into the
volume **only when the target file does not already exist**. After the first
boot the volume copy is authoritative and the seed is ignored — redeploys never
clobber live data. Leave the `*_SEED_URL` vars unset to start with empty DBs
(the app creates the schema on its own).

## Notes

- `claude.ts` and `grok.ts` are not imported by `index.ts` (dead at runtime);
  no Claude/Grok credentials are required.
- The build needs outbound network for `bun install`, `pip install`,
  `build_dict.ts` (edrdg.org), and the `mozc_dict.db` fetch.
