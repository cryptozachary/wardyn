/**
 * Per-user quota tracking backed by SQLite.
 * Persists across restarts. Sliding 1-hour window.
 *
 * Defaults: 100 LLM calls/hour, 120 expensive skill calls/hour per user.
 * Configurable at runtime via settings (USER_QUOTA_LLM, USER_QUOTA_EXPENSIVE) —
 * settingsStore resolves DB override → env → default on each lookup, so changes
 * from the Settings UI take effect on the next quota check without a restart.
 */

import { getDb } from "../db.js";
import { getSettingNumber } from "./settingsStore.js";

export interface QuotaConfig {
  llmCallsPerHour: number;
  expensiveSkillsPerHour: number;
}

export interface QuotaStatus {
  userId: string;
  llmCalls: number;
  llmLimit: number;
  llmRemaining: number;
  expensiveCalls: number;
  expensiveLimit: number;
  expensiveRemaining: number;
  resetInMs: number;
}

const EXPENSIVE_SKILLS = new Set([
  "browser_skill",
  "image_gen_skill",
  "code_runner_skill",
  "market_scanner_skill",
  "email_skill",
]);

const WINDOW_MS = 3_600_000; // 1 hour

function llmLimit(): number {
  return getSettingNumber("USER_QUOTA_LLM") ?? 100;
}

function expensiveLimit(): number {
  return getSettingNumber("USER_QUOTA_EXPENSIVE") ?? 120;
}

function countRecent(userId: string, kind: string, now: number): number {
  const db = getDb();
  const cutoff = now - WINDOW_MS;
  const row = db.prepare(
    "SELECT COUNT(*) as cnt FROM quota_events WHERE user_id = ? AND kind = ? AND ts > ?"
  ).get(userId, kind, cutoff) as any;
  return row.cnt;
}

function oldestTs(userId: string, kind: string, now: number): number | null {
  const db = getDb();
  const cutoff = now - WINDOW_MS;
  const row = db.prepare(
    "SELECT MIN(ts) as oldest FROM quota_events WHERE user_id = ? AND kind = ? AND ts > ?"
  ).get(userId, kind, cutoff) as any;
  return row.oldest ?? null;
}

function record(userId: string, kind: string, now: number): void {
  const db = getDb();
  db.prepare("INSERT INTO quota_events (user_id, kind, ts) VALUES (?, ?, ?)").run(userId, kind, now);
}

/** Check and record an LLM call. Returns { allowed, remaining }. */
export function checkLLMQuota(userId: string): { allowed: boolean; remaining: number; resetInMs: number } {
  const now = Date.now();
  const count = countRecent(userId, "llm", now);
  const limit = llmLimit();

  if (count >= limit) {
    const oldest = oldestTs(userId, "llm", now);
    return { allowed: false, remaining: 0, resetInMs: oldest ? WINDOW_MS - (now - oldest) : WINDOW_MS };
  }

  record(userId, "llm", now);
  const oldest = oldestTs(userId, "llm", now);
  return {
    allowed: true,
    remaining: limit - count - 1,
    resetInMs: oldest ? WINDOW_MS - (now - oldest) : WINDOW_MS,
  };
}

/** Check and record an expensive skill call. Returns { allowed, remaining }. */
export function checkSkillQuota(userId: string, skillName: string): { allowed: boolean; remaining: number; isExpensive: boolean } {
  const limit = expensiveLimit();
  if (!EXPENSIVE_SKILLS.has(skillName)) {
    return { allowed: true, remaining: limit, isExpensive: false };
  }

  const now = Date.now();
  const count = countRecent(userId, "expensive", now);

  if (count >= limit) {
    return { allowed: false, remaining: 0, isExpensive: true };
  }

  record(userId, "expensive", now);
  return {
    allowed: true,
    remaining: limit - count - 1,
    isExpensive: true,
  };
}

/** Get current quota status for a user. */
export function getQuotaStatus(userId: string): QuotaStatus {
  const now = Date.now();
  const llmCount = countRecent(userId, "llm", now);
  const expensiveCount = countRecent(userId, "expensive", now);
  const oldest = oldestTs(userId, "llm", now);
  const llmCap = llmLimit();
  const expensiveCap = expensiveLimit();

  return {
    userId,
    llmCalls: llmCount,
    llmLimit: llmCap,
    llmRemaining: Math.max(0, llmCap - llmCount),
    expensiveCalls: expensiveCount,
    expensiveLimit: expensiveCap,
    expensiveRemaining: Math.max(0, expensiveCap - expensiveCount),
    resetInMs: oldest ? WINDOW_MS - (now - oldest) : WINDOW_MS,
  };
}

/** Get all active user quotas (for admin dashboard). */
export function getAllQuotas(): QuotaStatus[] {
  const db = getDb();
  const cutoff = Date.now() - WINDOW_MS;
  const rows = db.prepare(
    "SELECT DISTINCT user_id FROM quota_events WHERE ts > ?"
  ).all(cutoff) as any[];
  return rows.map(r => getQuotaStatus(r.user_id)).filter(q => q.llmCalls > 0 || q.expensiveCalls > 0);
}

// Clean up old quota events every 10 minutes
setInterval(() => {
  try {
    const db = getDb();
    const cutoff = Date.now() - WINDOW_MS;
    db.prepare("DELETE FROM quota_events WHERE ts < ?").run(cutoff);
  } catch {}
}, 600_000).unref();
