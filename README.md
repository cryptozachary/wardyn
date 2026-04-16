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

1. A setup window prompts the user to choose a vault passphrase (≥ 8 chars).
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

## Tests

```bash
npm run test:security     # unit security tests
npm run test:integration  # auth + CSRF + webhook verification (in-process)
npm run build && npm run smoke  # boot the compiled server and probe the contract
```
