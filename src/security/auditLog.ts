import { randomUUID, createHash } from "crypto";
import { getDb } from "../db.js";
import { BLOCKED_PATTERNS } from "./safetySpine.js";

const SENSITIVE_KEY = /(key|token|secret|password|passphrase|credential)/i;

export interface AuditEvent {
  id: string;
  ts: number;
  type: "block" | "tool_exec";
  channel: string;
  sessionId: string;
  blockedCommand?: string;
  patternLabel?: string;
  patternIndex?: number;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  durationMs?: number;
  success?: boolean;
  error?: string;
  prevHash?: string;
  hash?: string;
}

export type ThreatLevel = "low" | "medium" | "high" | "critical";

export interface AuditStats {
  totalBlocks: number;
  totalToolExecs: number;
  toolExecSuccessRate: number;
  blocksByCategory: Record<string, number>;
  toolExecsByName: Record<string, { total: number; failures: number; avgDurationMs: number }>;
  threatLevel: ThreatLevel;
  lastBlockTs: number | null;
}

export interface PatternInfo {
  index: number;
  label: string;
  regex: string;
  hitCount: number;
}

function sanitizeValue(key: string | null, value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (depth > 8) return "[depth-limit]";
  if (key !== null && SENSITIVE_KEY.test(key)) return "***";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return value.length > 100 ? value.slice(0, 100) + "..." : value;
  if (typeof value !== "object") return value;
  if (seen.has(value as object)) return "[cycle]";
  seen.add(value as object);
  if (Array.isArray(value)) {
    return value.map(v => sanitizeValue(null, v, seen, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = sanitizeValue(k, v, seen, depth + 1);
  }
  return out;
}

function sanitizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const seen = new WeakSet<object>();
  return sanitizeValue(null, args, seen, 0) as Record<string, unknown>;
}

function hashEvent(event: AuditEvent): string {
  const { hash: _h, ...rest } = event;
  return createHash("sha256").update(JSON.stringify(rest)).digest("hex");
}

class AuditLogger {
  private lastHash: string = "GENESIS";

  constructor() {
    this.loadLastHash();
  }

  private loadLastHash(): void {
    try {
      const db = getDb();
      const row = db.prepare("SELECT hash FROM audit_events ORDER BY ts DESC, rowid DESC LIMIT 1").get() as any;
      if (row?.hash) this.lastHash = row.hash;
    } catch {}
  }

  private insert(event: AuditEvent): void {
    event.prevHash = this.lastHash;
    event.hash = hashEvent(event);
    this.lastHash = event.hash;

    const db = getDb();
    db.prepare(`
      INSERT INTO audit_events
        (id, ts, type, channel, session_id, blocked_command, pattern_label, pattern_index,
         tool_name, tool_args, duration_ms, success, error, prev_hash, hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.id, event.ts, event.type, event.channel, event.sessionId,
      event.blockedCommand ?? null, event.patternLabel ?? null, event.patternIndex ?? null,
      event.toolName ?? null, event.toolArgs ? JSON.stringify(event.toolArgs) : null,
      event.durationMs ?? null, event.success != null ? (event.success ? 1 : 0) : null,
      event.error ?? null, event.prevHash ?? null, event.hash ?? null,
    );
  }

  logBlock(label: string, command: string, channel: string, sessionId: string, patternIndex?: number): void {
    const event: AuditEvent = {
      id: randomUUID(),
      ts: Date.now(),
      type: "block",
      channel,
      sessionId,
      blockedCommand: command.length > 200 ? command.slice(0, 200) + "..." : command,
      patternLabel: label,
      patternIndex,
    };
    this.insert(event);
  }

  logToolExec(
    toolName: string, args: Record<string, unknown>,
    channel: string, sessionId: string,
    durationMs: number, success: boolean, error?: string
  ): void {
    const event: AuditEvent = {
      id: randomUUID(),
      ts: Date.now(),
      type: "tool_exec",
      channel,
      sessionId,
      toolName,
      toolArgs: sanitizeArgs(args),
      durationMs,
      success,
      error: error ? (error.length > 500 ? error.slice(0, 500) + "..." : error) : undefined,
    };
    this.insert(event);
  }

  getRecentEvents(limit = 50, offset = 0, type?: "block" | "tool_exec"): { events: AuditEvent[]; total: number } {
    const db = getDb();
    let countSql = "SELECT COUNT(*) as cnt FROM audit_events";
    let selectSql = "SELECT * FROM audit_events";
    const params: any[] = [];

    if (type) {
      countSql += " WHERE type = ?";
      selectSql += " WHERE type = ?";
      params.push(type);
    }

    const total = (db.prepare(countSql).get(...params) as any).cnt;

    selectSql += " ORDER BY ts DESC, rowid DESC LIMIT ? OFFSET ?";
    const rows = db.prepare(selectSql).all(...params, limit, offset) as any[];

    const events: AuditEvent[] = rows.map(r => ({
      id: r.id,
      ts: r.ts,
      type: r.type,
      channel: r.channel,
      sessionId: r.session_id,
      blockedCommand: r.blocked_command ?? undefined,
      patternLabel: r.pattern_label ?? undefined,
      patternIndex: r.pattern_index ?? undefined,
      toolName: r.tool_name ?? undefined,
      toolArgs: r.tool_args ? JSON.parse(r.tool_args) : undefined,
      durationMs: r.duration_ms ?? undefined,
      success: r.success != null ? !!r.success : undefined,
      error: r.error ?? undefined,
      prevHash: r.prev_hash ?? undefined,
      hash: r.hash ?? undefined,
    }));

    return { events, total };
  }

  getStats(): AuditStats {
    const db = getDb();
    const oneHourAgo = Date.now() - 3_600_000;

    // Block stats
    const blockTotal = (db.prepare("SELECT COUNT(*) as cnt FROM audit_events WHERE type = 'block'").get() as any).cnt;
    const blocksLastHour = (db.prepare("SELECT COUNT(*) as cnt FROM audit_events WHERE type = 'block' AND ts > ?").get(oneHourAgo) as any).cnt;
    const lastBlock = db.prepare("SELECT ts FROM audit_events WHERE type = 'block' ORDER BY ts DESC LIMIT 1").get() as any;

    // Blocks by category
    const blockCats = db.prepare(
      "SELECT pattern_label, COUNT(*) as cnt FROM audit_events WHERE type = 'block' AND pattern_label IS NOT NULL GROUP BY pattern_label"
    ).all() as any[];
    const blocksByCategory: Record<string, number> = {};
    for (const r of blockCats) blocksByCategory[r.pattern_label] = r.cnt;

    // Tool exec stats
    const toolTotal = (db.prepare("SELECT COUNT(*) as cnt FROM audit_events WHERE type = 'tool_exec'").get() as any).cnt;
    const toolSuccesses = (db.prepare("SELECT COUNT(*) as cnt FROM audit_events WHERE type = 'tool_exec' AND success = 1").get() as any).cnt;

    const toolRows = db.prepare(
      "SELECT tool_name, COUNT(*) as total, SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as failures, AVG(duration_ms) as avg_dur FROM audit_events WHERE type = 'tool_exec' AND tool_name IS NOT NULL GROUP BY tool_name"
    ).all() as any[];
    const toolExecsByName: Record<string, { total: number; failures: number; avgDurationMs: number }> = {};
    for (const r of toolRows) {
      toolExecsByName[r.tool_name] = { total: r.total, failures: r.failures, avgDurationMs: Math.round(r.avg_dur ?? 0) };
    }

    let threatLevel: ThreatLevel = "low";
    if (blocksLastHour >= 10) threatLevel = "critical";
    else if (blocksLastHour >= 3) threatLevel = "high";
    else if (blocksLastHour >= 1) threatLevel = "medium";

    return {
      totalBlocks: blockTotal,
      totalToolExecs: toolTotal,
      toolExecSuccessRate: toolTotal > 0 ? toolSuccesses / toolTotal : 1,
      blocksByCategory,
      toolExecsByName,
      threatLevel,
      lastBlockTs: lastBlock?.ts ?? null,
    };
  }

  getPatternHitCounts(): PatternInfo[] {
    const db = getDb();
    const rows = db.prepare(
      "SELECT pattern_index, COUNT(*) as cnt FROM audit_events WHERE type = 'block' AND pattern_index IS NOT NULL GROUP BY pattern_index"
    ).all() as any[];
    const hitMap = new Map<number, number>();
    for (const r of rows) hitMap.set(r.pattern_index, r.cnt);

    return BLOCKED_PATTERNS.map((p, i) => ({
      index: i,
      label: p.label,
      regex: p.regex.source,
      hitCount: hitMap.get(i) ?? 0,
    }));
  }

  verifyChain(): { valid: boolean; totalChecked: number; brokenLinks: number[] } {
    const db = getDb();
    const rows = db.prepare("SELECT * FROM audit_events ORDER BY ts ASC, rowid ASC").all() as any[];

    let prevHash = "GENESIS";
    const brokenLinks: number[] = [];

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (!r.hash) continue;

      const evt: AuditEvent = {
        id: r.id, ts: r.ts, type: r.type, channel: r.channel, sessionId: r.session_id,
        blockedCommand: r.blocked_command ?? undefined, patternLabel: r.pattern_label ?? undefined,
        patternIndex: r.pattern_index ?? undefined, toolName: r.tool_name ?? undefined,
        toolArgs: r.tool_args ? JSON.parse(r.tool_args) : undefined,
        durationMs: r.duration_ms ?? undefined,
        success: r.success != null ? !!r.success : undefined,
        error: r.error ?? undefined, prevHash: r.prev_hash ?? undefined, hash: r.hash ?? undefined,
      };

      if (evt.prevHash && evt.prevHash !== prevHash) brokenLinks.push(i);
      const computed = hashEvent(evt);
      if (computed !== evt.hash) brokenLinks.push(i);
      prevHash = evt.hash!;
    }

    return { valid: brokenLinks.length === 0, totalChecked: rows.length, brokenLinks };
  }

  exportLog(): string {
    const db = getDb();
    const rows = db.prepare("SELECT * FROM audit_events ORDER BY ts ASC, rowid ASC").all() as any[];
    return rows.map(r => {
      const evt: AuditEvent = {
        id: r.id, ts: r.ts, type: r.type, channel: r.channel, sessionId: r.session_id,
        blockedCommand: r.blocked_command ?? undefined, patternLabel: r.pattern_label ?? undefined,
        patternIndex: r.pattern_index ?? undefined, toolName: r.tool_name ?? undefined,
        toolArgs: r.tool_args ? JSON.parse(r.tool_args) : undefined,
        durationMs: r.duration_ms ?? undefined,
        success: r.success != null ? !!r.success : undefined,
        error: r.error ?? undefined, prevHash: r.prev_hash ?? undefined, hash: r.hash ?? undefined,
      };
      return JSON.stringify(evt);
    }).join("\n") + "\n";
  }

  /**
   * Aggregate tool executions over the last `hours` window.
   * Returns per-tool summary + hourly buckets for a simple activity chart.
   */
  getToolHistory(hours = 24): {
    windowHours: number;
    perTool: Array<{ tool: string; total: number; failures: number; successRate: number; avgDurationMs: number; lastTs: number }>;
    hourly: Array<{ hourStart: number; total: number; failures: number }>;
    totals: { total: number; failures: number; successRate: number };
  } {
    const db = getDb();
    const since = Date.now() - hours * 3600_000;

    const perToolRows = db.prepare(
      `SELECT tool_name,
              COUNT(*) as total,
              SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as failures,
              AVG(duration_ms) as avg_dur,
              MAX(ts) as last_ts
       FROM audit_events
       WHERE type = 'tool_exec' AND tool_name IS NOT NULL AND ts >= ?
       GROUP BY tool_name
       ORDER BY total DESC`
    ).all(since) as any[];

    const perTool = perToolRows.map(r => ({
      tool: r.tool_name,
      total: r.total,
      failures: r.failures,
      successRate: r.total > 0 ? (r.total - r.failures) / r.total : 1,
      avgDurationMs: Math.round(r.avg_dur ?? 0),
      lastTs: r.last_ts,
    }));

    // Bucket by hour
    const hourMs = 3600_000;
    const bucketStart = Math.floor(since / hourMs) * hourMs;
    const buckets = new Map<number, { total: number; failures: number }>();
    for (let t = bucketStart; t <= Date.now(); t += hourMs) {
      buckets.set(t, { total: 0, failures: 0 });
    }
    const hourlyRows = db.prepare(
      `SELECT ts, success FROM audit_events WHERE type = 'tool_exec' AND ts >= ?`
    ).all(since) as any[];
    for (const r of hourlyRows) {
      const h = Math.floor(r.ts / hourMs) * hourMs;
      const b = buckets.get(h);
      if (b) {
        b.total++;
        if (r.success === 0) b.failures++;
      }
    }
    const hourly = Array.from(buckets.entries())
      .sort(([a], [b]) => a - b)
      .map(([hourStart, v]) => ({ hourStart, ...v }));

    const total = perTool.reduce((s, t) => s + t.total, 0);
    const failures = perTool.reduce((s, t) => s + t.failures, 0);

    return {
      windowHours: hours,
      perTool,
      hourly,
      totals: { total, failures, successRate: total > 0 ? (total - failures) / total : 1 },
    };
  }

  clearLog(): void {
    const db = getDb();
    db.prepare("DELETE FROM audit_events").run();
    this.lastHash = "GENESIS";
  }

  /**
   * Recompute prev_hash + hash for every event in chronological order,
   * restarting from GENESIS. Use after a chain break is detected (e.g. from
   * a botched migration or pre-chain rows imported in a backfill). This
   * destroys the historical attestation for prior events but restores a
   * valid chain so future inserts continue to be tamper-evident.
   *
   * Returns { fixed, total } so callers can report the impact.
   */
  reseedChain(): { fixed: number; total: number } {
    const db = getDb();
    const rows = db.prepare("SELECT * FROM audit_events ORDER BY ts ASC, rowid ASC").all() as any[];
    const update = db.prepare("UPDATE audit_events SET prev_hash = ?, hash = ? WHERE id = ?");
    let prev = "GENESIS";
    let fixed = 0;
    const txn = db.transaction(() => {
      for (const r of rows) {
        const evt: AuditEvent = {
          id: r.id, ts: r.ts, type: r.type, channel: r.channel, sessionId: r.session_id,
          blockedCommand: r.blocked_command ?? undefined, patternLabel: r.pattern_label ?? undefined,
          patternIndex: r.pattern_index ?? undefined, toolName: r.tool_name ?? undefined,
          toolArgs: r.tool_args ? JSON.parse(r.tool_args) : undefined,
          durationMs: r.duration_ms ?? undefined,
          success: r.success != null ? !!r.success : undefined,
          error: r.error ?? undefined,
          prevHash: prev,
        };
        const newHash = hashEvent(evt);
        if (r.prev_hash !== prev || r.hash !== newHash) {
          update.run(prev, newHash, r.id);
          fixed++;
        }
        prev = newHash;
      }
    });
    txn();
    this.lastHash = prev;
    return { fixed, total: rows.length };
  }

  /**
   * Delete audit events older than `retentionDays`. Re-seeds the hash-chain
   * head from the newest surviving event so the chain remains continuous
   * for future inserts (older links are archived out-of-band).
   *
   * Returns the number of rows deleted.
   */
  pruneOlderThan(retentionDays: number): number {
    if (!Number.isFinite(retentionDays) || retentionDays <= 0) return 0;
    const db = getDb();
    const cutoff = Date.now() - retentionDays * 24 * 3_600_000;
    const info = db.prepare("DELETE FROM audit_events WHERE ts < ?").run(cutoff);
    const head = db
      .prepare("SELECT hash FROM audit_events ORDER BY ts DESC, rowid DESC LIMIT 1")
      .get() as any;
    this.lastHash = head?.hash ?? "GENESIS";
    return info.changes ?? 0;
  }
}

export const auditLogger = new AuditLogger();
