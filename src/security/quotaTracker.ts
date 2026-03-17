/**
 * Per-user quota tracking for LLM calls and expensive skill usage.
 * Prevents a single user from exhausting API budgets.
 *
 * Defaults: 100 LLM calls/hour, 20 expensive skill calls/hour per user.
 * Configurable via env: USER_QUOTA_LLM, USER_QUOTA_EXPENSIVE.
 */

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

interface UserBucket {
  llmCalls: number[];
  expensiveCalls: number[];
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

const buckets = new Map<string, UserBucket>();

function getBucket(userId: string): UserBucket {
  let b = buckets.get(userId);
  if (!b) {
    b = { llmCalls: [], expensiveCalls: [] };
    buckets.set(userId, b);
  }
  return b;
}

function pruneOld(timestamps: number[], now: number): number[] {
  return timestamps.filter(t => now - t < WINDOW_MS);
}

/** Check and record an LLM call. Returns { allowed, remaining }. */
export function checkLLMQuota(userId: string): { allowed: boolean; remaining: number; resetInMs: number } {
  const now = Date.now();
  const bucket = getBucket(userId);
  bucket.llmCalls = pruneOld(bucket.llmCalls, now);

  if (bucket.llmCalls.length >= config.llmCallsPerHour) {
    const oldest = bucket.llmCalls[0];
    return { allowed: false, remaining: 0, resetInMs: WINDOW_MS - (now - oldest) };
  }

  bucket.llmCalls.push(now);
  return {
    allowed: true,
    remaining: config.llmCallsPerHour - bucket.llmCalls.length,
    resetInMs: bucket.llmCalls.length > 0 ? WINDOW_MS - (now - bucket.llmCalls[0]) : WINDOW_MS,
  };
}

/** Check and record an expensive skill call. Returns { allowed, remaining }. */
export function checkSkillQuota(userId: string, skillName: string): { allowed: boolean; remaining: number; isExpensive: boolean } {
  if (!EXPENSIVE_SKILLS.has(skillName)) {
    return { allowed: true, remaining: config.expensiveSkillsPerHour, isExpensive: false };
  }

  const now = Date.now();
  const bucket = getBucket(userId);
  bucket.expensiveCalls = pruneOld(bucket.expensiveCalls, now);

  if (bucket.expensiveCalls.length >= config.expensiveSkillsPerHour) {
    return { allowed: false, remaining: 0, isExpensive: true };
  }

  bucket.expensiveCalls.push(now);
  return {
    allowed: true,
    remaining: config.expensiveSkillsPerHour - bucket.expensiveCalls.length,
    isExpensive: true,
  };
}

/** Get current quota status for a user. */
export function getQuotaStatus(userId: string): QuotaStatus {
  const now = Date.now();
  const bucket = getBucket(userId);
  bucket.llmCalls = pruneOld(bucket.llmCalls, now);
  bucket.expensiveCalls = pruneOld(bucket.expensiveCalls, now);

  const oldestLlm = bucket.llmCalls[0];
  const resetInMs = oldestLlm ? WINDOW_MS - (now - oldestLlm) : WINDOW_MS;

  return {
    userId,
    llmCalls: bucket.llmCalls.length,
    llmLimit: config.llmCallsPerHour,
    llmRemaining: Math.max(0, config.llmCallsPerHour - bucket.llmCalls.length),
    expensiveCalls: bucket.expensiveCalls.length,
    expensiveLimit: config.expensiveSkillsPerHour,
    expensiveRemaining: Math.max(0, config.expensiveSkillsPerHour - bucket.expensiveCalls.length),
    resetInMs,
  };
}

/** Get all active user quotas (for admin dashboard). */
export function getAllQuotas(): QuotaStatus[] {
  const now = Date.now();
  const result: QuotaStatus[] = [];
  for (const userId of buckets.keys()) {
    result.push(getQuotaStatus(userId));
  }
  return result.filter(q => q.llmCalls > 0 || q.expensiveCalls > 0);
}

// Clean up stale entries every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [userId, bucket] of buckets) {
    bucket.llmCalls = pruneOld(bucket.llmCalls, now);
    bucket.expensiveCalls = pruneOld(bucket.expensiveCalls, now);
    if (bucket.llmCalls.length === 0 && bucket.expensiveCalls.length === 0) {
      buckets.delete(userId);
    }
  }
}, 600_000).unref();
