# Enterprise Readiness Roadmap

Sequencing and implementation plan for the five features that unlock
Enterprise-tier sales ($6k/yr starting). These are ordered by unlock-value,
not by effort — SSO is first because without it nothing else converts.

## Priority ranking

| # | Feature                        | Effort   | Unlocks                            | Blocking? |
|---|--------------------------------|----------|------------------------------------|-----------|
| 1 | SAML / OIDC SSO                | 3-4 wks  | Any enterprise conversation        | Yes       |
| 2 | RBAC / multi-workspace         | 4-6 wks  | Team tier + Enterprise             | Yes       |
| 3 | SBOM in release pipeline       | 1 day    | Vendor security questionnaires     | No        |
| 4 | Signed audit export endpoint   | 3-5 days | Regulated-industry differentiation | No        |
| 5 | SOC 2 Type I                   | 6-9 mo   | Mid-market + enterprise deals      | Calendar  |

Build 3 and 4 in parallel with 1 or 2 — they're small and unblock
procurement questionnaires.

---

## 1. SAML / OIDC SSO

### Goal

Let an enterprise admin point Wardyn at their Okta / Azure AD / Google
Workspace tenant so users sign in through the IdP instead of typing a
password. Access is revoked automatically when the IdP disables the user.

### Library choices

- **OIDC**: `openid-client` (the maintained one, by Filip Skokan). No
  passport dependency needed — it works standalone.
- **SAML**: `@node-saml/node-saml`. The passport-saml package is the older
  wrapper around the same core.
- **Avoid**: rolling your own. SAML especially has decades of subtle
  bypass bugs (XML canonicalization, signature wrapping, etc.).

### File layout

```
src/security/sso/
  ├── config.ts        # reads IdP config from encrypted vault
  ├── oidc.ts          # OIDC authorization-code flow + callback
  ├── saml.ts          # SAML SP-initiated SSO + ACS callback
  ├── provisioning.ts  # Just-In-Time user/role provisioning from IdP claims
  └── index.ts         # mounts routes on the gateway
```

### New routes

| Method | Path                                | Purpose                                         |
|--------|-------------------------------------|-------------------------------------------------|
| GET    | `/auth/sso/login?provider=<id>`     | Redirect to IdP                                 |
| GET    | `/auth/sso/callback/oidc`           | OIDC redirect URI; issues session cookie        |
| POST   | `/auth/sso/callback/saml`           | SAML ACS URL; issues session cookie             |
| GET    | `/auth/sso/metadata`                | Our SP metadata XML (for SAML IdP config)       |
| GET    | `/api/admin/sso/providers`          | List configured IdPs (admin only)               |
| POST   | `/api/admin/sso/providers`          | Upsert IdP config (admin only, stored in vault) |
| DELETE | `/api/admin/sso/providers/:id`      | Remove IdP                                      |

### Schema additions

```sql
CREATE TABLE sso_providers (
  id TEXT PRIMARY KEY,            -- e.g. "okta-prod"
  kind TEXT NOT NULL,             -- "oidc" | "saml"
  display_name TEXT NOT NULL,
  config_ref TEXT NOT NULL,       -- pointer into providers.enc vault entry
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,            -- internal uuid
  email TEXT UNIQUE NOT NULL,
  display_name TEXT,
  idp_provider TEXT,              -- nullable; null = local API_TOKEN user
  idp_subject TEXT,               -- stable subject claim from IdP
  created_at INTEGER NOT NULL,
  last_login_at INTEGER,
  disabled_at INTEGER,
  UNIQUE(idp_provider, idp_subject)
);
```

### Session cookie changes

Today `wardyn_auth` is an HMAC of a fixed payload. Extend it to embed
`user_id` so requests carry identity, not just "logged in". Existing
single-token installs stay working because `API_TOKEN` → synthetic
user_id=`"root"`.

### Decision points

- **Group → role mapping**: start with email-domain-based group claim
  (`groups: ["wardyn-admins"]` → admin role). Revisit with customer feedback.
- **JIT provisioning**: auto-create user on first IdP login. Don't require
  pre-provisioning via SCIM until an enterprise explicitly asks — SCIM is a
  whole separate implementation.
- **Session lifetime**: keep the existing cookie TTL. SSO doesn't change
  session duration, just how the session is *initiated*.

### Open questions

- Do we support multiple IdPs per install? (Yes — multi-tenant hosted needs it.)
- Do we support IdP-initiated SAML? (Defer. SP-initiated is cleaner.)

---

## 2. RBAC / Multi-Workspace

### Goal

Multiple users on one install, scoped by role. Multi-workspace isolates
tenants so hosted Team tier works. Single-user installs must continue
working unchanged.

### Schema

```sql
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE workspace_members (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL,             -- "owner" | "admin" | "operator" | "viewer"
  added_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);

-- Add workspace_id to every workspace-scoped table:
ALTER TABLE sessions         ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE skills_approved  ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE canvas_items     ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE audit_events     ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE llm_usage        ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';
-- ...etc for every table that holds user-scoped data
```

Migration: create a `default` workspace, assign all existing rows to it,
assign the single existing root user to it as `owner`.

### Role → capability matrix

| Capability                          | viewer | operator | admin | owner |
|-------------------------------------|--------|----------|-------|-------|
| Read sessions, canvas, audit        | ✓      | ✓        | ✓     | ✓     |
| Execute skills                      |        | ✓        | ✓     | ✓     |
| Approve new skills                  |        |          | ✓     | ✓     |
| Rotate API tokens, change vault     |        |          | ✓     | ✓     |
| Invite / remove members             |        |          | ✓     | ✓     |
| Delete workspace, change billing    |        |          |       | ✓     |

Encode as a single `hasCapability(user, workspace, capability)` function
in `src/security/rbac.ts`. Middleware factory: `requireCap(cap)`.

### Request-scoping middleware

A new `src/security/context.ts` resolves `req.user`, `req.workspace`, and
`req.capabilities` from the session cookie. Runs before any `/api/*` route.
Workspace picked from:

1. `X-Workspace-Id` header (server-to-server)
2. `workspace_id` query param (UI route)
3. User's default workspace (last used, stored on `users`)

### Channel routing implications

Today channel webhooks (`/webhook/slack`, `/webhook/discord`, etc.) are
single-tenant — one Slack workspace per install. Multi-workspace needs:

- `channels` table keyed by `(workspace_id, channel_kind, external_id)`
- Webhook handlers look up which workspace an incoming message belongs
  to via the signing secret (Slack signing secret is unique per workspace)
- Per-workspace rate limits

This is the biggest scope creep in the RBAC work. Estimate 40% of the
effort is channel refactoring, not roles.

### Backward compatibility

Single-user installs keep working because:

- `default` workspace exists
- `root` user exists and is `owner` of `default`
- API_TOKEN auth maps to `root@default` automatically
- All existing URLs still resolve (no `/w/<workspace>/` prefix)

---

## 3. SBOM Generation in Release Pipeline

### Goal

Every released artifact ships with a CycloneDX JSON manifest listing
every dependency + version + license. Attach it to the GitHub release so
customers' security teams can grep it.

### Implementation

```bash
npm install --save-dev @cyclonedx/cyclonedx-npm
```

New script `scripts/generate-sbom.mjs`:

```js
import { execSync } from "child_process";
import path from "path";
import { writeFileSync } from "fs";

const out = path.resolve("release", "sbom.cyclonedx.json");
execSync(
  `npx @cyclonedx/cyclonedx-npm --output-file ${out} --output-format JSON --omit dev`,
  { stdio: "inherit" }
);
console.log(`Wrote ${out}`);
```

Wire into `package.json`:

```json
"scripts": {
  "sbom": "node scripts/generate-sbom.mjs",
  "dist": "npm run build && npm run fetch-node && npm run sbom && electron-builder"
}
```

Add to electron-builder config so it ships inside the installer:

```json
"extraResources": [
  { "from": "release/sbom.cyclonedx.json", "to": "sbom.cyclonedx.json" }
]
```

Optional follow-up: sign the SBOM with the same key used for audit
exports. A detached signature (`sbom.cyclonedx.json.sig`) proves the
manifest wasn't modified after release.

### Effort

One afternoon. No new dependencies in the runtime, just devDependencies.

---

## 4. Signed Audit Export Endpoint

### Goal

Let an admin export a date range of `audit_events` as a tamper-evident
archive that a third party (auditor, court, regulator) can verify without
trusting Wardyn to have been honest at export time.

### Endpoint

```
POST /api/security/audit/export
Content-Type: application/json

{
  "from": "2026-01-01T00:00:00Z",
  "to":   "2026-03-31T23:59:59Z",
  "workspace_id": "default",
  "format": "json"          // or "ndjson"
}
```

Response (200): a tarball streamed as `application/gzip` containing:

```
audit-export-2026-01-01_2026-03-31/
  ├── manifest.json         # metadata + checksums + signature
  ├── events.ndjson         # one audit_event per line, ordered by seq
  ├── chain-head.json       # first event's prev_hash + row to anchor chain
  ├── chain-tail.json       # last event's hash + row
  └── verify.mjs            # standalone verifier (no dependencies)
```

### Signing

Use the existing `config/signing_key.pem` (ed25519). The manifest
contains:

```json
{
  "version": 1,
  "generated_at": "2026-04-17T14:00:00Z",
  "range": { "from": "...", "to": "..." },
  "workspace_id": "default",
  "event_count": 14823,
  "events_sha256": "...",       // hash of events.ndjson
  "chain_head_prev_hash": "...",
  "chain_tail_hash": "...",
  "signer_public_key": "..."    // ed25519 pub key, hex
}
```

The manifest itself is signed; signature goes in `manifest.json.sig` (or
as a `signature` field within).

### Verifier

`verify.mjs` is a self-contained script the recipient runs:

```bash
node verify.mjs
# ✓ events.ndjson sha256 matches manifest
# ✓ hash chain continuous across 14823 events
# ✓ chain head links to stated prev_hash
# ✓ manifest signature verifies against pinned public key
```

It has no npm dependencies — only Node stdlib (`crypto`, `fs`). This
matters: a verifier the recipient has to `npm install` won't be run.

### Implementation notes

- Stream events to NDJSON instead of buffering — exports can be millions
  of rows.
- The endpoint is admin-only and rate-limited.
- Log the export itself as an audit event (export is auditable).

---

## 5. SOC 2 Type I

### Goal

Produce a SOC 2 Type I attestation report from a licensed auditor,
covering the Security trust service criterion at minimum, so Wardyn can
be listed in enterprise vendor catalogs.

### Timeline (9 months realistic)

**Month 1-2: readiness assessment + tooling**

- Sign up for Vanta ($11k/yr) or Drata (similar). Pick one.
- Connect integrations: GitHub, AWS/GCP, cloud IdP, payroll. The tooling
  automates evidence collection from these.
- Get the readiness dashboard. It'll show maybe 40-60% control coverage
  on day one — that's normal.

**Month 2-4: policy authoring**

Write or adopt templated policies for:

- Information security policy
- Access control policy
- Change management policy
- Incident response plan
- Business continuity / disaster recovery
- Vendor management policy
- Data classification & handling
- Acceptable use policy
- Risk assessment methodology

Vanta/Drata provide templates. Don't write them from scratch.

**Month 3-5: control implementation**

Close the gaps the readiness assessment surfaced. Typical ones:

- MFA on every admin account (GitHub, AWS, npm, Vanta itself)
- Centralized logging with retention (you're largely here already via
  audit_events)
- Background checks on employees (probably N/A as solo founder)
- Formal code review requirements (branch protection on `main`)
- Encryption at rest and in transit documentation
- Annual risk assessment + annual policy review cadence

**Month 5-6: evidence collection**

Type I only requires evidence at a single point in time, not continuous.
Vanta screenshots configs, pulls git history, grabs ticketing data.

**Month 6-9: auditor engagement**

- Hire a SOC 2 auditor (Type I range: $8-15k). Not through Vanta —
  Vanta/Drata partner with external firms. Insight Assurance, Prescient
  Assurance, BARR are common.
- Audit window: 4-8 weeks of back-and-forth.
- Final report: the PDF you hand to enterprise prospects.

### Costs

| Item                        | Cost            |
|-----------------------------|-----------------|
| Vanta or Drata subscription | $11-14k / yr    |
| SOC 2 Type I auditor        | $8-15k one-time |
| Pen test (usually required) | $5-10k one-time |
| Legal review of policies    | $2-5k optional  |
| **Total Year 1**            | **$26-44k**     |

### When to start

Start the process as soon as the first enterprise prospect asks for SOC
2 and is willing to wait. Don't start speculatively — the clock on
evidence collection is real and policies go stale.

### Type II

Plan to upgrade to Type II within 18 months of Type I. Type II requires
6-12 months of *continuous* evidence that controls operate. That's where
"we screenshotted it once" stops working. Enterprises beyond a certain
size will require Type II outright.

---

## Cross-cutting concerns

### Testing

- SSO: spin up a mock IdP (e.g., `node-oidc-provider` in test mode) and
  run end-to-end auth flow tests. Don't hit real Okta in CI.
- RBAC: every new endpoint needs a test matrix: viewer/operator/admin ×
  allowed/denied.
- Audit export: verify that a tampered event file fails verification, a
  tampered manifest fails signature check, and a valid export round-trips.

### Documentation

Each feature gets a section in README.md. Enterprise customers will
especially want:

- SSO setup guide per provider (Okta, Azure AD, Google Workspace, Ping)
- RBAC reference with role → capability matrix
- Audit export verification instructions

### Licensing split

Keep core features under AGPLv3. Move these enterprise features into a
`enterprise/` subtree licensed under a commercial license. Build-time
flag `ENTERPRISE_BUILD=1` includes them; the OSS build excludes the
directory. This is how GitLab, Grafana, and Sentry do it.

---

## Suggested execution order

1. **Week 1**: SBOM + basic signed audit export (quick wins, unblocks
   procurement questionnaires even before SSO lands).
2. **Weeks 2-5**: SSO (OIDC first, SAML second — OIDC covers Google
   Workspace and most modern IdPs).
3. **Weeks 6-11**: RBAC + multi-workspace.
4. **Month 3 onward**: Begin SOC 2 process in parallel with sales
   motion. The 9-month SOC 2 clock runs alongside everything else.
5. **Month 4+**: Full signed audit export with verifier; SBOM signing;
   SSO for SAML; SCIM provisioning (if requested).

By month 6 you have a sellable enterprise SKU. By month 9-12 you have
SOC 2 Type I and can list in enterprise vendor catalogs.
