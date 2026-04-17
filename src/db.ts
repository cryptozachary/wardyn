/**
 * Central SQLite database for SecureClaw.
 *
 * Replaces JSON-file storage for: sessions, audit events, quota tracking,
 * heartbeat triage logs, hub registry, and approval queue.
 *
 * Uses better-sqlite3 (synchronous, WAL mode) for safe concurrent reads
 * and serialized writes without race conditions.
 */

import Database from "better-sqlite3";
import path from "path";
import { mkdirSync } from "fs";

const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "secureclaw.db");

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;

  mkdirSync(DATA_DIR, { recursive: true });

  _db = new Database(DB_PATH);

  // Performance & safety pragmas
  _db.pragma("journal_mode = WAL");
  _db.pragma("synchronous = NORMAL");
  _db.pragma("foreign_keys = ON");
  _db.pragma("busy_timeout = 5000");

  migrate(_db);

  return _db;
}

/** Run all migrations idempotently. */
function migrate(db: Database.Database): void {
  db.exec(`
    -- ─────────── Sessions ───────────
    CREATE TABLE IF NOT EXISTS sessions (
      id               TEXT PRIMARY KEY,
      user_id          TEXT NOT NULL,
      summary          TEXT NOT NULL DEFAULT '',
      messages         TEXT NOT NULL DEFAULT '[]',   -- JSON array of SessionMessage
      created_at       INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL,
      strategist_mode  INTEGER NOT NULL DEFAULT 0,   -- 0/1 — persists across restarts
      -- Encrypted blob stored alongside for integrity (optional)
      hmac             TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user    ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at);

    -- ─────────── Audit Events ───────────
    CREATE TABLE IF NOT EXISTS audit_events (
      id              TEXT PRIMARY KEY,
      ts              INTEGER NOT NULL,
      type            TEXT NOT NULL CHECK(type IN ('block','tool_exec')),
      channel         TEXT NOT NULL,
      session_id      TEXT NOT NULL,
      blocked_command  TEXT,
      pattern_label   TEXT,
      pattern_index   INTEGER,
      tool_name       TEXT,
      tool_args       TEXT,       -- JSON
      duration_ms     INTEGER,
      success         INTEGER,    -- 0/1
      error           TEXT,
      prev_hash       TEXT,
      hash            TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_audit_ts   ON audit_events(ts);
    CREATE INDEX IF NOT EXISTS idx_audit_type ON audit_events(type);
    CREATE INDEX IF NOT EXISTS idx_audit_tool ON audit_events(tool_name);
    CREATE INDEX IF NOT EXISTS idx_audit_session ON audit_events(session_id);

    -- ─────────── Quota Tracking ───────────
    CREATE TABLE IF NOT EXISTS quota_events (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id   TEXT NOT NULL,
      kind      TEXT NOT NULL CHECK(kind IN ('llm','expensive')),
      ts        INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_quota_user_kind ON quota_events(user_id, kind, ts);

    -- ─────────── Heartbeat Triage Log ───────────
    CREATE TABLE IF NOT EXISTS heartbeat_triage (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      ts          INTEGER NOT NULL,
      job         TEXT NOT NULL,
      mode        TEXT NOT NULL,
      acted       INTEGER NOT NULL,  -- 0/1
      reason      TEXT NOT NULL,
      prompt      TEXT,
      duration_ms INTEGER NOT NULL,
      result      TEXT,
      error       TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_triage_ts  ON heartbeat_triage(ts);
    CREATE INDEX IF NOT EXISTS idx_triage_job ON heartbeat_triage(job);

    -- ─────────── Hub Registry ───────────
    CREATE TABLE IF NOT EXISTS hub_packages (
      name         TEXT PRIMARY KEY,
      version      TEXT NOT NULL,
      language     TEXT NOT NULL,
      description  TEXT,
      author       TEXT,
      exported_at  TEXT NOT NULL,
      file_name    TEXT NOT NULL,
      checksum     TEXT NOT NULL
    );

    -- ─────────── Approval Queue ───────────
    CREATE TABLE IF NOT EXISTS approvals (
      id                TEXT PRIMARY KEY,
      type              TEXT NOT NULL CHECK(type IN ('build','import')),
      skill_name        TEXT NOT NULL,
      language          TEXT NOT NULL,
      description       TEXT NOT NULL,
      code              TEXT NOT NULL,
      wrapper_code      TEXT,
      skill_md          TEXT NOT NULL,
      parameters        TEXT NOT NULL DEFAULT '{}',  -- JSON
      secrets           TEXT,                        -- JSON
      sample_args       TEXT,                        -- JSON
      author            TEXT,
      requested_at      INTEGER NOT NULL,
      status            TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
      reviewed_at       INTEGER,
      reject_reason     TEXT,
      ast_warnings      TEXT,                        -- JSON
      validation_output TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);

    -- ─────────── Heartbeat Jobs ───────────
    CREATE TABLE IF NOT EXISTS heartbeat_jobs (
      name            TEXT PRIMARY KEY,
      cron            TEXT NOT NULL,
      prompt          TEXT NOT NULL,
      enabled         INTEGER NOT NULL DEFAULT 1,   -- 0/1
      mode            TEXT NOT NULL DEFAULT 'fixed' CHECK(mode IN ('fixed','smart')),
      scan_window_ms  INTEGER NOT NULL DEFAULT 7200000,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL
    );
  `);

  // Loop guard state (survives restarts so circuit breakers aren't reset
  // by a crash or redeploy)
  db.exec(`
    CREATE TABLE IF NOT EXISTS loop_guard_state (
      session_id  TEXT PRIMARY KEY,
      state       TEXT NOT NULL,
      updated_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_loop_guard_updated ON loop_guard_state(updated_at);
  `);

  // LLM usage metrics (token counts + latency per call)
  db.exec(`
    CREATE TABLE IF NOT EXISTS llm_usage (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      ts             INTEGER NOT NULL,
      provider       TEXT NOT NULL,
      model          TEXT,
      session_id     TEXT,
      channel        TEXT,
      prompt_tokens  INTEGER,
      output_tokens  INTEGER,
      duration_ms    INTEGER,
      cost_usd       REAL,
      fallback_used  INTEGER NOT NULL DEFAULT 0,
      error          TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_llm_usage_ts ON llm_usage(ts);
    CREATE INDEX IF NOT EXISTS idx_llm_usage_provider ON llm_usage(provider, ts);
  `);

  // Runtime-editable settings (shadow env for a narrow allow-list)
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key         TEXT PRIMARY KEY,
      value       TEXT NOT NULL,
      updated_at  INTEGER NOT NULL
    );
  `);

  // Canvas items (agent-pushed UI surface)
  db.exec(`
    CREATE TABLE IF NOT EXISTS canvas_items (
      id          TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL,
      kind        TEXT NOT NULL CHECK(kind IN ('markdown','table','chart','html','code','json')),
      title       TEXT,
      data        TEXT NOT NULL,         -- JSON payload (shape depends on kind)
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_canvas_session ON canvas_items(session_id, created_at);
  `);

  // Additive migrations for existing installations
  addColumnIfMissing(db, "sessions", "strategist_mode", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "sessions", "thinking_level", "TEXT NOT NULL DEFAULT 'medium'");
  addColumnIfMissing(db, "llm_usage", "cached_tokens", "INTEGER");
  addColumnIfMissing(db, "llm_usage", "cache_write_tokens", "INTEGER");
}

/** Idempotent ALTER TABLE — adds a column only if it doesn't already exist. */
function addColumnIfMissing(db: Database.Database, table: string, column: string, decl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }
}

/** Graceful shutdown. */
export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
