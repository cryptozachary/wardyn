# Wardyn

Wardyn is a self-hosted agent gateway exposing a WebSocket + REST control plane
for an LLM-driven skill runtime. This README covers operations: how to boot it,
what to configure, and how to keep it safe in production.

## Quickstart (dev)

```bash
npm ci
npm run build
API_TOKEN=dev-token-xxxxxxxxxxxxxxxxxxxxxxx \
  KEY_PASSPHRASE=dev \
  COOKIE_SECRET=dev-cookie-xxxxxxxxxxxxxxxxx \
  npm run start
```

Open `http://127.0.0.1:3000/login` and sign in with the `API_TOKEN`.

## Environment

| Var | Required | Default | Notes |
| --- | --- | --- | --- |
| `API_TOKEN` | **prod** | — | ≥24 chars; used for both header auth and login. |
| `KEY_PASSPHRASE` | **prod** | — | Decrypts the provider/key vault. |
| `COOKIE_SECRET` | **prod** | — | Signs browser session cookies. |
| `NODE_ENV` | no | `development` | Set to `production` to enable strict validation + HSTS. |
| `PORT` | no | `3000` | Public listener port (`/health`, `/webhook/*`, `/ws`). |
| `HOST` | no | `127.0.0.1` | Always loopback — put a reverse proxy in front for TLS. |
| `ADMIN_PORT` | no | — | If set, `/api/*`, `/ui`, `/output` move to this listener only. |
| `ADMIN_HOST` | no | `127.0.0.1` | Bind host for the admin listener. |
| `TRUST_PROXY` | no | `loopback` | Passed to `app.set('trust proxy', …)`. |
| `BODY_LIMIT` | no | `1mb` | Request body cap. |
| `RATE_LIMIT` | no | `30` | HTTP req/min per IP. |
| `WS_RATE_LIMIT` | no | `20` | WebSocket msgs/min per connection. |
| `TELEGRAM_WEBHOOK_SECRET` | per channel | — | Required to accept `/webhook/telegram`. |
| `DISCORD_PUBLIC_KEY` | per channel | — | Ed25519 hex; required to accept `/webhook/discord`. |
| Slack signing secret | per channel | — | Stored in encrypted vault (`config/providers.enc`). Required for `/webhook/slack`. |
| `ENABLE_HSTS` | no | off (on in prod) | Forces `Strict-Transport-Security` even in dev. |
| `LOG_LEVEL` | no | `info` | One of `debug`/`info`/`warn`/`error`. |
| `LOG_FORMAT` | no | `json` | `json` (one record per line, shipper-friendly) or `pretty` (color-tagged human terminal output). |
| `LOG_SERVICE` | no | `wardyn` | `service` field stamped on every JSON record — disambiguates multi-process deployments in Loki/Datadog/etc. |
| `AUDIT_RETENTION_DAYS` | no | `90` | Audit events older than this are pruned every 6h. Hash-chain head is re-seeded from the newest survivor. |
| `CANVAS_RETENTION_DAYS` | no | `7` | Canvas items older than this are pruned every 6h. |
| `CANVAS_MAX_ITEMS` | no | `5000` | Hard cap on total canvas rows after age prune. |
| `LLM_DAILY_BUDGET_USD` | no | — | If set, LLM calls are refused once the last 24h of `llm_usage` rows exceed this budget. |
| `HEARTBEAT_STALL_FACTOR` | no | `3` | A heartbeat job is considered stalled when its last success is older than `intervalMs × this`. |
| `HEARTBEAT_STALL_FAILURES` | no | `5` | Consecutive failures after which a job is reported as stalled. |
| `WARDYN_AUTOUPDATE` | no | on (packaged) | Set to `0` to disable Electron auto-update checks. |
| `WARDYN_UPDATE_URL` | no | `publish` in package.json | Override the update feed URL at runtime. |
| `WARDYN_ALLOWED_ORIGINS` | no | loopback only | Comma-separated extra Origins permitted to open cookie-auth WebSockets. Default allows `http(s)://{HOST,127.0.0.1,localhost}:{PORT,ADMIN_PORT}` plus `file://` (Electron). Token-auth WS connections bypass this check. |
| `WHATSAPP_ENABLED` | no | off | Set to `1` to start the WhatsApp adapter. **Read the WhatsApp note below before enabling.** |

## Auth model

Two callers are supported:

1. **Server-to-server**: send `x-api-token: $API_TOKEN`. Bypasses CSRF.
2. **Browser**: POST the token to `/api/auth/login`. Server sets an
   `HttpOnly; SameSite=Strict` session cookie and a `wardyn_csrf` cookie.
   Mutating requests (POST/PUT/DELETE) must echo the CSRF cookie back as
   `x-csrf-token`. Logout is `POST /api/auth/logout`.

In production, boot aborts if any of `API_TOKEN`, `KEY_PASSPHRASE`, `COOKIE_SECRET`
are missing, or if `API_TOKEN` is shorter than 24 characters.

## Surface split

Two logical listeners:

- **Public** (`PORT`, bound to `HOST`): `/health`, `/webhook/*`, `/ws`.
- **Admin** (`ADMIN_PORT` if set, else same as public): `/api/*`, `/ui`,
  `/chat`, `/canvas`, `/output`, `/uploads`.

When `ADMIN_PORT` is unset, both surfaces share the single listener (fine for
local dev). In production deploy with `ADMIN_PORT` set and bind the admin
listener to a loopback or private network; put TLS + HSTS on both.

### Reverse proxy

Example nginx fragment:

```nginx
# Public surface behind TLS
server {
  listen 443 ssl http2;
  server_name your.domain;
  ssl_certificate     /etc/ssl/fullchain.pem;
  ssl_certificate_key /etc/ssl/privkey.pem;
  add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

  location /webhook/ { proxy_pass http://127.0.0.1:3000; proxy_set_header X-Forwarded-For $remote_addr; }
  location /ws       { proxy_pass http://127.0.0.1:3000; proxy_http_version 1.1; proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "Upgrade"; }
  location /health   { proxy_pass http://127.0.0.1:3000; }
}

# Admin surface — separate vhost + IP allowlist
server {
  listen 443 ssl http2;
  server_name admin.your.domain;
  allow 10.0.0.0/8; deny all;     # or put this behind your VPN
  # ... tls ...
  location / { proxy_pass http://127.0.0.1:3001; }
}
```

## Secret bootstrap

```bash
# 1. Store the provider key (encrypted under KEY_PASSPHRASE)
npm run store-key
# 2. Configure channel tokens via /api/channels/config (stored in providers.enc)
# 3. Seed heartbeat jobs in config/heartbeat.json, then boot.
```

## Deploy

```bash
docker build -t wardyn -f docker/sandbox.dockerfile .
docker run -d --name wardyn \
  -e API_TOKEN=... -e KEY_PASSPHRASE=... -e COOKIE_SECRET=... -e NODE_ENV=production \
  -e ADMIN_PORT=3001 \
  -p 127.0.0.1:3000:3000 -p 127.0.0.1:3001:3001 \
  -v /srv/wardyn/data:/app/data \
  -v /srv/wardyn/config:/app/config \
  wardyn
```

## Rollback

Backups are created by `npm run backup` (dumps DB, config, memory, skills) and
restored by `npm run restore -- --from backups/<dir>`. Restore refuses to run
while the server is up unless `--force`.

## Incident response

- Rotate `API_TOKEN`, `COOKIE_SECRET`, `KEY_PASSPHRASE` → restart.
- Review `audit_events` table + `/api/security/events` for suspicious tool
  execution. The table uses a hash-chain; verify via `/api/security/verify-chain`.
- Metrics: `GET /api/metrics` (admin) surfaces request counts, latency p50/p95/p99,
  5xx rate, tool success/failure counts.
- Pull a snapshot: `npm run backup -- --include-logs` and hand the archive to
  the responder.

## Desktop (Electron)

Wardyn can be run as an Electron desktop app. First-run bootstrap uses
**Option C**: a vault passphrase held in the user's head, plus lower-value
session tokens stored in the OS keychain (via Electron's `safeStorage`).

```bash
npm ci            # installs electron as a dev-dep
npm run build     # compiles TS + copies electron assets to dist/
npm run electron  # launches the desktop app
```

### First launch

1. A setup window prompts the user to choose a vault passphrase. The policy
   is ≥ 12 chars and at least 3 of 4 character classes (lowercase, uppercase,
   digit, symbol); a single repeated character is rejected.
2. The app generates a random `API_TOKEN` and `COOKIE_SECRET`, seeds the
   encrypted provider vault with a placeholder entry (so the passphrase can
   be round-trip-verified later), and stores the two tokens under
   `userData/bootstrap.bin` encrypted with OS-managed `safeStorage`.
3. The API token is shown **once** so the user can copy it for server-to-server
   use. It is not recoverable after that window closes.

### Subsequent launches

1. An unlock window prompts for the vault passphrase. Wrong passphrase fails
   silently without hitting the server.
2. On success the main process spawns the gateway as a child with env vars
   (`API_TOKEN`, `COOKIE_SECRET`, `KEY_PASSPHRASE`, `HOST=127.0.0.1`), waits
   for `/health`, POSTs the token to `/api/auth/login`, and injects the
   resulting cookie into the main `BrowserWindow` session before loading
   `/ui/hub.html`. The user never sees a login screen.

### Data dir

In packaged mode, `DATA_DIR` = Electron's `userData` path (per-user isolated).
In `npm run electron` dev mode, `DATA_DIR` = repo root so existing
`config/`, `data/`, `memory/` directories are reused.

### What Option C does NOT protect against

- Malware running as the same OS user *while the app is running* can read
  decrypted provider keys from gateway process memory. The vault passphrase
  raises the bar for **offline** disk theft and **pre-unlock** compromise.
- Losing the passphrase bricks the vault. Back it up out-of-band.

### Auto-update

Packaged builds self-update via `electron-updater` against the feed declared in
`package.json#build.publish` (override per-host with `WARDYN_UPDATE_URL`). The
app checks on launch and every 6 hours; when an update downloads, a restart
dialog is shown. Disable entirely with `WARDYN_AUTOUPDATE=0`. The dependency
is optional — the app still runs if `electron-updater` isn't installed.

### Gateway child process

The main process spawns the compiled gateway as a child and restarts it on
unexpected exit with exponential backoff (500 ms → 10 s), capped at 5 restarts
per 60 s window. If the cap is hit the app surfaces a fatal error rather than
silently crash-looping.

The child is spawned with `SKILLS_ROOT` and `APP_ROOT` env vars set to the
packaged `resources/` tree. `process.cwd()` in the child points at `DATA_DIR`
(user-writable state), so any code that needs to read shipped resources must
resolve paths via those env vars rather than `process.cwd()`.

### Packaging the installer

```bash
npm run pack    # builds to release/win-unpacked/ — no installer, fast iteration
npm run dist    # builds the full platform installer into release/
```

Both targets run `scripts/fetch-node.mjs`, which downloads a portable Node
runtime into `electron/node-runtime/` and ships it as an extraResource. The
script defaults to `process.version`, so the bundled runtime always matches
the Node that compiled the native modules (`better-sqlite3`) during
`npm install` — avoiding `NODE_MODULE_VERSION` ABI mismatches at runtime.
Delete `electron/node-runtime/` to force a re-fetch when changing Node
versions.

Because `build.npmRebuild` is `false` and electron-builder prunes
`devDependencies`, anything imported at runtime (e.g. `typescript` via the
AST analyzer) must live in `dependencies`, not `devDependencies`.

## Production readiness

Features that matter for single-operator production use:

- **Encryption at rest** — session message payloads (`sessions.messages` +
  `sessions.summary` in SQLite) are encrypted with AES-256-GCM. The key is
  derived per-record from `KEY_PASSPHRASE` via scrypt; ciphertext is tagged
  with a `v1:` prefix to distinguish from legacy plaintext. When
  `KEY_PASSPHRASE` is unset, payloads round-trip as plaintext so dev and
  tests still work.
- **Retention** — `AUDIT_RETENTION_DAYS` and `CANVAS_RETENTION_DAYS` +
  `CANVAS_MAX_ITEMS` run on a 6-hour interval. The audit log's hash-chain
  head is re-seeded from the newest surviving row so future events chain
  continuously.
- **Loop guard persistence** — per-session circuit-breaker state survives
  process restarts via the `loop_guard_state` table; stale rows (> 7 days)
  are dropped automatically.
- **LLM cost tracking** — every `callLLM` invocation records provider, model,
  token counts, latency, and estimated USD cost into `llm_usage`. View the
  rollup at `GET /api/security/llm-usage?hours=24`. Set
  `LLM_DAILY_BUDGET_USD` to enforce a hard budget; overrides to the price
  table live in `config/llm-pricing.json`.
- **SSRF + DNS-rebinding** — `checkSSRF` + `safeLookup` together close the
  TOCTOU window by ensuring the socket connects to the same address that
  was validated. Used by hub skill imports and any outbound fetch routed
  through the SSRF guard.
- **Backup integrity** — `npm run backup` writes a SHA-256 checksum for
  every file into the manifest and runs `PRAGMA quick_check` on the DB
  snapshot immediately after writing. Validation failure exits code 2, so
  a broken archive never lands in your rotation.
- **Heartbeat safety** — smart-mode triage prompts are scanned through
  SafetySpine before execution; blocks are routed to the audit log.

## Channels — caveats

### WhatsApp (`WHATSAPP_ENABLED=1`)

The WhatsApp adapter uses [`baileys`](https://github.com/WhiskeySockets/Baileys),
a reverse-engineered WhatsApp Web client. **It is not an official Meta API.**
Connecting an account this way violates the WhatsApp Terms of Service and the
account may be banned without warning. Use it only on a throwaway number for
personal automation. For anything load-bearing, switch to the official
WhatsApp Cloud API (not currently wired up).

Telegram, Discord, and Slack all use first-party APIs and are not subject to
this caveat.

## Operations

### Filesystem layout

All runtime state resolves from `DATA_DIR` (default: `process.cwd()`).
Set it explicitly when deploying under systemd or any runner that
doesn't anchor cwd — it removes the need for `WorkingDirectory=`:

```
$DATA_DIR/
  config/                    # providers.enc, channels.json, models.json, ...
  secureclaw.db              # SQLite (DATA_DIR set) — or <cwd>/data/secureclaw.db in dev
  logs/  sessions/  uploads/
  output/  memory/  sandbox/
  skills_pending/  backups/  hub/
```

Read-only resources (the `public/` UI, bundled `skills/`) resolve from
`APP_ROOT` (default: `process.cwd()`). The Electron packaging sets
`APP_ROOT` to the resource tree and `DATA_DIR` to the per-user appData
path so both points are correctly separated for installed builds.

### Audit chain

The audit log is a SHA-256 hash chain (`prev_hash` → `hash`) so any tampering
or row deletion is detectable via `GET /api/security/verify-chain`. If the
chain is reported as broken (e.g. after a migration that touched
`audit_events` directly, or a backfill), rebuild it from genesis with:

```bash
npm run doctor -- --reseed-audit
```

Reseed rewrites every `prev_hash`/`hash` so future inserts continue from a
valid head. **It destroys the historical attestation** for prior events —
export the old log via `GET /api/security/export` first if you need it for
forensics.

## Tests

```bash
npm run test:security     # unit security tests
npm run test:integration  # auth + CSRF + webhook verification (in-process)
npm run test:readiness    # encryption, retention, loop-guard persistence, cost tracking, SSRF lookup
npm test                  # runs all three above in sequence
npm run build && npm run smoke  # boot the compiled server and probe the contract
```
