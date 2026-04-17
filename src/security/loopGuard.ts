import { createHash } from "crypto";
import { getDb } from "../db.js";

/**
 * Loop Guard — SHA-256 based tool call dedup with circuit breaker.
 * Detects when the agent is stuck calling the same tool with the same args
 * in a loop and breaks the cycle.
 */

interface CallRecord {
  hash: string;
  count: number;
  firstSeen: number;
  lastSeen: number;
}

interface CircuitState {
  calls: Map<string, CallRecord>;
  totalCalls: number;
  tripCount: number;
  trippedAt: number | null;
}

export interface LoopGuardConfig {
  /** Max identical calls before tripping (default: 3) */
  maxDuplicates: number;
  /** Time window in ms for dedup tracking (default: 120_000 = 2 min) */
  windowMs: number;
  /** Cooldown after circuit trips before allowing calls again (default: 30_000 = 30s) */
  cooldownMs: number;
  /** Max total calls per session window before hard stop (default: 50) */
  maxTotalCalls: number;
}

const DEFAULT_CONFIG: LoopGuardConfig = {
  maxDuplicates: 3,
  windowMs: 120_000,
  cooldownMs: 30_000,
  maxTotalCalls: 50,
};

export interface LoopGuardResult {
  allowed: boolean;
  reason?: string;
  duplicateCount?: number;
  totalCalls?: number;
}

/** Hash a tool call (name + args) into a stable fingerprint */
function hashCall(toolName: string, args: Record<string, unknown>): string {
  const payload = JSON.stringify({ t: toolName, a: args });
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

// Per-session circuit states (in-memory cache, hydrated from SQLite)
const sessions = new Map<string, CircuitState>();
const dirty = new Set<string>();

function serializeState(s: CircuitState): string {
  return JSON.stringify({
    calls: Array.from(s.calls.entries()),
    totalCalls: s.totalCalls,
    tripCount: s.tripCount,
    trippedAt: s.trippedAt,
  });
}

function deserializeState(raw: string): CircuitState {
  const obj = JSON.parse(raw);
  return {
    calls: new Map(obj.calls ?? []),
    totalCalls: obj.totalCalls ?? 0,
    tripCount: obj.tripCount ?? 0,
    trippedAt: obj.trippedAt ?? null,
  };
}

function persist(sessionId: string, state: CircuitState): void {
  try {
    getDb().prepare(
      "INSERT INTO loop_guard_state (session_id, state, updated_at) VALUES (?, ?, ?) " +
      "ON CONFLICT(session_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at"
    ).run(sessionId, serializeState(state), Date.now());
  } catch {}
}

function loadFromDb(sessionId: string): CircuitState | null {
  try {
    const row = getDb().prepare("SELECT state FROM loop_guard_state WHERE session_id = ?").get(sessionId) as any;
    if (row?.state) return deserializeState(row.state);
  } catch {}
  return null;
}

// Flush dirty states + cleanup every 5 minutes
setInterval(() => {
  for (const sid of dirty) {
    const state = sessions.get(sid);
    if (state) persist(sid, state);
  }
  dirty.clear();

  const now = Date.now();
  for (const [sid, state] of sessions) {
    if (now - (state.trippedAt ?? 0) > 600_000 && state.totalCalls === 0) {
      sessions.delete(sid);
    }
  }
  // Drop stale DB rows (7 days untouched)
  try {
    getDb().prepare("DELETE FROM loop_guard_state WHERE updated_at < ?")
      .run(now - 7 * 24 * 3_600_000);
  } catch {}
}, 300_000).unref();

function getSession(sessionId: string): CircuitState {
  let state = sessions.get(sessionId);
  if (!state) {
    state = loadFromDb(sessionId) ?? { calls: new Map(), totalCalls: 0, tripCount: 0, trippedAt: null };
    sessions.set(sessionId, state);
  }
  return state;
}

function markDirty(sessionId: string): void {
  dirty.add(sessionId);
}

function pruneExpired(state: CircuitState, config: LoopGuardConfig): void {
  const cutoff = Date.now() - config.windowMs;
  for (const [hash, record] of state.calls) {
    if (record.lastSeen < cutoff) {
      state.totalCalls -= record.count;
      state.calls.delete(hash);
    }
  }
  if (state.totalCalls < 0) state.totalCalls = 0;
}

/**
 * Check if a tool call should be allowed.
 * Call this BEFORE executing the tool.
 */
export function checkLoop(
  sessionId: string,
  toolName: string,
  args: Record<string, unknown>,
  config: Partial<LoopGuardConfig> = {}
): LoopGuardResult {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const state = getSession(sessionId);
  const now = Date.now();

  // Prune expired records
  pruneExpired(state, cfg);

  // Check if circuit is tripped and still in cooldown
  if (state.trippedAt && now - state.trippedAt < cfg.cooldownMs) {
    return {
      allowed: false,
      reason: `Circuit breaker tripped (${state.tripCount} trips). Cooling down for ${Math.ceil((cfg.cooldownMs - (now - state.trippedAt)) / 1000)}s.`,
      totalCalls: state.totalCalls,
    };
  }

  // Reset trip state after cooldown
  if (state.trippedAt && now - state.trippedAt >= cfg.cooldownMs) {
    state.trippedAt = null;
  }

  // Check total call limit
  if (state.totalCalls >= cfg.maxTotalCalls) {
    state.tripCount++;
    state.trippedAt = now;
    markDirty(sessionId);
    return {
      allowed: false,
      reason: `Total call limit exceeded (${state.totalCalls}/${cfg.maxTotalCalls} in ${cfg.windowMs / 1000}s window). Circuit breaker tripped.`,
      totalCalls: state.totalCalls,
    };
  }

  // Check duplicate calls
  const hash = hashCall(toolName, args);
  const existing = state.calls.get(hash);

  if (existing) {
    existing.count++;
    existing.lastSeen = now;
    state.totalCalls++;

    if (existing.count > cfg.maxDuplicates) {
      state.tripCount++;
      state.trippedAt = now;
      markDirty(sessionId);
      return {
        allowed: false,
        reason: `Duplicate call detected: ${toolName} called ${existing.count} times with same args. Circuit breaker tripped.`,
        duplicateCount: existing.count,
        totalCalls: state.totalCalls,
      };
    }
  } else {
    state.calls.set(hash, { hash, count: 1, firstSeen: now, lastSeen: now });
    state.totalCalls++;
  }

  markDirty(sessionId);
  return {
    allowed: true,
    duplicateCount: existing?.count ?? 1,
    totalCalls: state.totalCalls,
  };
}

/** Reset loop guard state for a session */
export function resetLoopGuard(sessionId: string): void {
  sessions.delete(sessionId);
  try {
    getDb().prepare("DELETE FROM loop_guard_state WHERE session_id = ?").run(sessionId);
  } catch {}
}

/** Get loop guard stats for a session */
export function getLoopGuardStats(sessionId: string): {
  totalCalls: number;
  uniqueCalls: number;
  tripCount: number;
  isTripped: boolean;
} {
  const state = sessions.get(sessionId);
  if (!state) return { totalCalls: 0, uniqueCalls: 0, tripCount: 0, isTripped: false };
  return {
    totalCalls: state.totalCalls,
    uniqueCalls: state.calls.size,
    tripCount: state.tripCount,
    isTripped: state.trippedAt !== null,
  };
}
