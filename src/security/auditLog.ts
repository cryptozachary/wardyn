import { appendFileSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { randomUUID, createHash } from "crypto";
import path from "path";
import { BLOCKED_PATTERNS } from "./safetySpine.js";

const LOG_DIR = path.join(process.cwd(), "logs");
const AUDIT_FILE = path.join(LOG_DIR, "audit.jsonl");
const BUFFER_SIZE = 500;

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
  /** SHA-256 hash of the previous event — forms a tamper-evident chain */
  prevHash?: string;
  /** SHA-256 hash of this event (computed over all fields except hash itself) */
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

function sanitizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (SENSITIVE_KEY.test(k)) {
      clean[k] = "***";
    } else if (typeof v === "string") {
      clean[k] = v.length > 100 ? v.slice(0, 100) + "..." : v;
    } else {
      clean[k] = v;
    }
  }
  return clean;
}

/** Compute SHA-256 hash of an event (excluding the hash field itself) */
function hashEvent(event: AuditEvent): string {
  const { hash: _h, ...rest } = event;
  return createHash("sha256").update(JSON.stringify(rest)).digest("hex");
}

class AuditLogger {
  private buffer: AuditEvent[] = [];
  private patternHits = new Map<number, number>();
  private lastHash: string = "GENESIS";

  constructor() {
    this.loadExisting();
  }

  private loadExisting(): void {
    if (!existsSync(AUDIT_FILE)) return;
    try {
      const lines = readFileSync(AUDIT_FILE, "utf8").trim().split("\n").filter(Boolean);
      const tail = lines.slice(-BUFFER_SIZE);
      for (const line of tail) {
        try {
          const evt: AuditEvent = JSON.parse(line);
          this.buffer.push(evt);
          if (evt.hash) this.lastHash = evt.hash;
          if (evt.type === "block" && evt.patternIndex != null) {
            this.patternHits.set(evt.patternIndex, (this.patternHits.get(evt.patternIndex) ?? 0) + 1);
          }
        } catch {}
      }
      // Count pattern hits from lines we didn't buffer
      if (lines.length > BUFFER_SIZE) {
        for (const line of lines.slice(0, -BUFFER_SIZE)) {
          try {
            const evt: AuditEvent = JSON.parse(line);
            if (evt.hash) this.lastHash = evt.hash;
            if (evt.type === "block" && evt.patternIndex != null) {
              this.patternHits.set(evt.patternIndex, (this.patternHits.get(evt.patternIndex) ?? 0) + 1);
            }
          } catch {}
        }
      }
    } catch {}
  }

  private append(event: AuditEvent): void {
    // Hash-chain: link this event to the previous one
    event.prevHash = this.lastHash;
    event.hash = hashEvent(event);
    this.lastHash = event.hash;

    this.buffer.push(event);
    if (this.buffer.length > BUFFER_SIZE) {
      this.buffer = this.buffer.slice(-BUFFER_SIZE);
    }
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(AUDIT_FILE, JSON.stringify(event) + "\n");
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
    if (patternIndex != null) {
      this.patternHits.set(patternIndex, (this.patternHits.get(patternIndex) ?? 0) + 1);
    }
    this.append(event);
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
    this.append(event);
  }

  getRecentEvents(limit = 50, offset = 0, type?: "block" | "tool_exec"): { events: AuditEvent[]; total: number } {
    let filtered = type ? this.buffer.filter(e => e.type === type) : this.buffer;
    const total = filtered.length;
    // Return newest first
    filtered = filtered.slice().reverse().slice(offset, offset + limit);
    return { events: filtered, total };
  }

  getStats(): AuditStats {
    const oneHourAgo = Date.now() - 3_600_000;
    let totalBlocks = 0;
    let totalToolExecs = 0;
    let toolExecSuccesses = 0;
    let lastBlockTs: number | null = null;
    let blocksLastHour = 0;
    const blocksByCategory: Record<string, number> = {};
    const toolMap: Record<string, { total: number; failures: number; totalDuration: number }> = {};

    for (const evt of this.buffer) {
      if (evt.type === "block") {
        totalBlocks++;
        if (evt.patternLabel) {
          blocksByCategory[evt.patternLabel] = (blocksByCategory[evt.patternLabel] ?? 0) + 1;
        }
        if (!lastBlockTs || evt.ts > lastBlockTs) lastBlockTs = evt.ts;
        if (evt.ts > oneHourAgo) blocksLastHour++;
      } else if (evt.type === "tool_exec") {
        totalToolExecs++;
        if (evt.success) toolExecSuccesses++;
        const name = evt.toolName ?? "unknown";
        if (!toolMap[name]) toolMap[name] = { total: 0, failures: 0, totalDuration: 0 };
        toolMap[name].total++;
        if (!evt.success) toolMap[name].failures++;
        toolMap[name].totalDuration += evt.durationMs ?? 0;
      }
    }

    let threatLevel: ThreatLevel = "low";
    if (blocksLastHour >= 10) threatLevel = "critical";
    else if (blocksLastHour >= 3) threatLevel = "high";
    else if (blocksLastHour >= 1) threatLevel = "medium";

    const toolExecsByName: Record<string, { total: number; failures: number; avgDurationMs: number }> = {};
    for (const [name, data] of Object.entries(toolMap)) {
      toolExecsByName[name] = {
        total: data.total,
        failures: data.failures,
        avgDurationMs: Math.round(data.totalDuration / data.total),
      };
    }

    return {
      totalBlocks,
      totalToolExecs,
      toolExecSuccessRate: totalToolExecs > 0 ? toolExecSuccesses / totalToolExecs : 1,
      blocksByCategory,
      toolExecsByName,
      threatLevel,
      lastBlockTs,
    };
  }

  getPatternHitCounts(): PatternInfo[] {
    return BLOCKED_PATTERNS.map((p, i) => ({
      index: i,
      label: p.label,
      regex: p.regex.source,
      hitCount: this.patternHits.get(i) ?? 0,
    }));
  }

  /** Verify the hash chain integrity. Returns broken links if tampered. */
  verifyChain(): { valid: boolean; totalChecked: number; brokenLinks: number[] } {
    if (!existsSync(AUDIT_FILE)) return { valid: true, totalChecked: 0, brokenLinks: [] };
    const lines = readFileSync(AUDIT_FILE, "utf8").trim().split("\n").filter(Boolean);
    let prevHash = "GENESIS";
    const brokenLinks: number[] = [];

    for (let i = 0; i < lines.length; i++) {
      try {
        const evt: AuditEvent = JSON.parse(lines[i]);
        // Skip legacy events without hash chain
        if (!evt.hash) continue;
        // Verify prevHash links to actual previous
        if (evt.prevHash && evt.prevHash !== prevHash) {
          brokenLinks.push(i);
        }
        // Verify event hash is correct
        const computed = hashEvent(evt);
        if (computed !== evt.hash) {
          brokenLinks.push(i);
        }
        prevHash = evt.hash;
      } catch {
        brokenLinks.push(i);
      }
    }

    return { valid: brokenLinks.length === 0, totalChecked: lines.length, brokenLinks };
  }

  exportLog(): string {
    if (!existsSync(AUDIT_FILE)) return "";
    return readFileSync(AUDIT_FILE, "utf8");
  }

  clearLog(): void {
    this.buffer = [];
    this.patternHits.clear();
    this.lastHash = "GENESIS";
    if (existsSync(AUDIT_FILE)) {
      writeFileSync(AUDIT_FILE, "", "utf8");
    }
  }
}

export const auditLogger = new AuditLogger();
