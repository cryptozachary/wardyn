/**
 * Heartbeat Job Store — CRUD operations backed by SQLite.
 *
 * On first run, seeds from config/heartbeat.json (if present) so existing
 * configurations migrate automatically. After that, the JSON file is ignored.
 */

import { existsSync, readFileSync } from "fs";
import { getDb } from "../db.js";
import type { HeartbeatJob } from "./heartbeat.js";
import { paths } from "../paths.js";

const CONFIG_PATH = paths.config("heartbeat.json");

/* ───────── Row ↔ HeartbeatJob ───────── */

function rowToJob(r: any): HeartbeatJob {
  return {
    name: r.name,
    cron: r.cron,
    prompt: r.prompt,
    enabled: !!r.enabled,
    mode: r.mode as "fixed" | "smart",
    scanWindowMs: r.scan_window_ms,
  };
}

/* ───────── Seed from JSON (one-time migration) ───────── */

export function seedFromJson(): number {
  if (!existsSync(CONFIG_PATH)) return 0;

  let jobs: HeartbeatJob[];
  try {
    jobs = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return 0;
  }

  const db = getDb();
  const now = Date.now();

  // INSERT OR IGNORE: seeds new jobs from JSON without overwriting existing ones
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO heartbeat_jobs (name, cron, prompt, enabled, mode, scan_window_ms, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let count = 0;
  for (const j of jobs) {
    const result = stmt.run(
      j.name, j.cron, j.prompt,
      j.enabled !== false ? 1 : 0,
      j.mode || "fixed",
      j.scanWindowMs ?? 7_200_000,
      now, now,
    );
    if (result.changes > 0) count++;
  }
  return count;
}

/* ───────── CRUD ───────── */

export function listJobs(enabledOnly = false): HeartbeatJob[] {
  const db = getDb();
  if (enabledOnly) {
    return (db.prepare("SELECT * FROM heartbeat_jobs WHERE enabled = 1 ORDER BY name").all() as any[]).map(rowToJob);
  }
  return (db.prepare("SELECT * FROM heartbeat_jobs ORDER BY name").all() as any[]).map(rowToJob);
}

export function getJob(name: string): HeartbeatJob | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM heartbeat_jobs WHERE name = ?").get(name) as any;
  return row ? rowToJob(row) : null;
}

export function createJob(job: HeartbeatJob): HeartbeatJob {
  const db = getDb();
  const now = Date.now();
  db.prepare(`
    INSERT INTO heartbeat_jobs (name, cron, prompt, enabled, mode, scan_window_ms, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    job.name, job.cron, job.prompt,
    job.enabled !== false ? 1 : 0,
    job.mode || "fixed",
    job.scanWindowMs ?? 7_200_000,
    now, now,
  );
  return getJob(job.name)!;
}

export function updateJob(name: string, updates: Partial<Omit<HeartbeatJob, "name">>): HeartbeatJob | null {
  const db = getDb();
  const existing = db.prepare("SELECT * FROM heartbeat_jobs WHERE name = ?").get(name) as any;
  if (!existing) return null;

  const merged = {
    cron: updates.cron ?? existing.cron,
    prompt: updates.prompt ?? existing.prompt,
    enabled: updates.enabled !== undefined ? (updates.enabled ? 1 : 0) : existing.enabled,
    mode: updates.mode ?? existing.mode,
    scan_window_ms: updates.scanWindowMs ?? existing.scan_window_ms,
  };

  db.prepare(`
    UPDATE heartbeat_jobs SET cron = ?, prompt = ?, enabled = ?, mode = ?, scan_window_ms = ?, updated_at = ?
    WHERE name = ?
  `).run(merged.cron, merged.prompt, merged.enabled, merged.mode, merged.scan_window_ms, Date.now(), name);

  return getJob(name);
}

export function deleteJob(name: string): boolean {
  const db = getDb();
  const result = db.prepare("DELETE FROM heartbeat_jobs WHERE name = ?").run(name);
  return result.changes > 0;
}
