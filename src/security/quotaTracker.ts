/**
 * Per-user quota tracking backed by SQLite.
 * Persists across restarts. Sliding 1-hour window.
 *
 * Defaults: 100 LLM calls/hour, 20 expensive skill calls/hour per user.
 * Configurable via env: USER_QUOTA_LLM, USER_QUOTA_EXPENSIVE.
 */

import { getDb } from "../db.js";

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

const config: QuotaConfig = {
  llmCallsPerHour: Number(process.env.USER_QUOTA_LLM) || 100,
  expensiveSkillsPerHour: Number(process.env.USER_QUOTA_EXPENSIVE) || 20,
};

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

  if (count >= config.llmCallsPerHour) {
    const oldest = oldestTs(userId, "llm", now);
    return { allowed: false, remaining: 0, resetInMs: oldest ? WINDOW_MS - (now - oldest) : WINDOW_MS };
  }

  record(userId, "llm", now);
  const oldest = oldestTs(userId, "llm", now);
  return {
    allowed: true,
    remaining: config.llmCallsPerHour - count - 1,
    resetInMs: oldest ? WINDOW_MS - (now - oldest) : WINDOW_MS,
  };
}

/** Check and record an expensive skill call. Returns { allowed, remaining }. */
export function checkSkillQuota(userId: string, skillName: string): { allowed: boolean; remaining: number; isExpensive: boolean } {
  if (!EXPENSIVE_SKILLS.has(skillName)) {
    return { allowed: true, remaining: config.expensiveSkillsPerHour, isExpensive: false };
  }

  const now = Date.now();
  const count = countRecent(userId, "expensive", now);

  if (count >= config.expensiveSkillsPerHour) {
    return { allowed: false, remaining: 0, isExpensive: true };
  }

  record(userId, "expensive", now);
  return {
    allowed: true,
    remaining: config.expensiveSkillsPerHour - count - 1,
    isExpensive: true,
  };
}

/** Get current quota status for a user. */
export function getQuotaStatus(userId: string): QuotaStatus {
  const now = Date.now();
  const llmCount = countRecent(userId, "llm", now);
  const expensiveCount = countRecent(userId, "expensive", now);
  const oldest = oldestTs(userId, "llm", now);

  return {
    userId,
    llmCalls: llmCount,
    llmLimit: config.llmCallsPerHour,
    llmRemaining: Math.max(0, config.llmCallsPerHour - llmCount),
    expensiveCalls: expensiveCount,
    expensiveLimit: config.expensiveSkillsPerHour,
    expensiveRemaining: Math.max(0, config.expensiveSkillsPerHour - expensiveCount),
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
