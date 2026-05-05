import { randomUUID } from "crypto";
import os from "os";

type Level = "debug" | "info" | "warn" | "error";
const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const CURRENT = (process.env.LOG_LEVEL as Level) || "info";
const CURRENT_NUM = LEVELS[CURRENT] ?? 20;

// LOG_FORMAT: "json" (default — shipper-friendly, one record per line) or
// "pretty" (human-readable for terminal use). Each JSON record carries
// service/pid/hostname so logs from multiple Wardyn processes can be
// disambiguated by Loki/Datadog/etc.
const FORMAT: "json" | "pretty" = (process.env.LOG_FORMAT === "pretty" ? "pretty" : "json");
const SERVICE = process.env.LOG_SERVICE || "wardyn";
const HOSTNAME = os.hostname();
const PID = process.pid;

function shouldLog(level: Level): boolean { return LEVELS[level] >= CURRENT_NUM; }

const COLORS: Record<Level, string> = {
  debug: "\x1b[2m", info: "\x1b[36m", warn: "\x1b[33m", error: "\x1b[31m",
};
const RESET = "\x1b[0m";

function formatPretty(level: Level, msg: string, fields: Record<string, unknown> | undefined, ts: string): string {
  const tag = `${COLORS[level]}${level.toUpperCase().padEnd(5)}${RESET}`;
  const head = `${ts.slice(11, 23)} ${tag} ${msg}`;
  if (!fields || Object.keys(fields).length === 0) return head;
  const tail = Object.entries(fields).map(([k, v]) => {
    const s = typeof v === "string" ? v : JSON.stringify(v);
    return `${k}=${s}`;
  }).join(" ");
  return `${head}  ${tail}`;
}

function emit(level: Level, msg: string, fields?: Record<string, unknown>) {
  if (!shouldLog(level)) return;
  const ts = new Date().toISOString();
  let line: string;
  if (FORMAT === "pretty") {
    line = formatPretty(level, msg, fields, ts);
  } else {
    const entry = {
      ts,
      level,
      levelnum: LEVELS[level],
      service: SERVICE,
      hostname: HOSTNAME,
      pid: PID,
      msg,
      ...(fields || {}),
    };
    line = JSON.stringify(entry);
  }
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => emit("debug", msg, fields),
  info:  (msg: string, fields?: Record<string, unknown>) => emit("info",  msg, fields),
  warn:  (msg: string, fields?: Record<string, unknown>) => emit("warn",  msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit("error", msg, fields),
};

export function newRequestId(): string { return randomUUID(); }

// Minimal counters (in-memory, for /metrics).
const counters = new Map<string, number>();
const latencies = new Map<string, number[]>();

export function incr(name: string, by = 1) {
  counters.set(name, (counters.get(name) || 0) + by);
}
export function observe(name: string, ms: number) {
  const arr = latencies.get(name) || [];
  arr.push(ms);
  if (arr.length > 1000) arr.shift();
  latencies.set(name, arr);
}
export function snapshotMetrics() {
  const out: Record<string, unknown> = {};
  for (const [k, v] of counters) out[`count_${k}`] = v;
  for (const [k, arr] of latencies) {
    if (arr.length === 0) continue;
    const sorted = [...arr].sort((a, b) => a - b);
    out[`latency_${k}`] = {
      n: sorted.length,
      p50: sorted[Math.floor(sorted.length * 0.5)],
      p95: sorted[Math.floor(sorted.length * 0.95)],
      p99: sorted[Math.floor(sorted.length * 0.99)],
    };
  }
  return out;
}

export function requestLogger() {
  return (req: any, res: any, next: any) => {
    const reqId = (req.get("x-request-id") as string) || newRequestId();
    req.reqId = reqId;
    res.setHeader("x-request-id", reqId);
    const start = Date.now();
    res.on("finish", () => {
      const dur = Date.now() - start;
      observe("http", dur);
      incr(`http_status_${Math.floor(res.statusCode / 100)}xx`);
      log.info("http", {
        reqId, method: req.method, path: req.path, status: res.statusCode, durationMs: dur,
      });
    });
    next();
  };
}
