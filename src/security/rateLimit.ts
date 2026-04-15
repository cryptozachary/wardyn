import type { Request, Response, NextFunction } from "express";
import { getDb } from "../db.js";

let initialized = false;
function init() {
  if (initialized) return;
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS rate_limit_hits (
      bucket TEXT NOT NULL,
      key    TEXT NOT NULL,
      ts     INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_rate_limit_bucket_key_ts ON rate_limit_hits(bucket, key, ts);
  `);
  initialized = true;
  setInterval(() => {
    try {
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      getDb().prepare("DELETE FROM rate_limit_hits WHERE ts < ?").run(cutoff);
    } catch {}
  }, 60 * 60 * 1000).unref();
}

export interface RateLimitOpts {
  bucket: string;
  windowMs: number;
  max: number;
  keyFn?: (req: Request) => string;
}

export function sqliteRateLimit(opts: RateLimitOpts) {
  init();
  return (req: Request, res: Response, next: NextFunction) => {
    const key = (opts.keyFn ? opts.keyFn(req) : req.ip) || "unknown";
    const now = Date.now();
    const cutoff = now - opts.windowMs;
    const db = getDb();
    try {
      db.prepare("DELETE FROM rate_limit_hits WHERE bucket=? AND key=? AND ts<?")
        .run(opts.bucket, key, cutoff);
      const row = db.prepare("SELECT COUNT(*) as c FROM rate_limit_hits WHERE bucket=? AND key=?")
        .get(opts.bucket, key) as { c: number };
      if (row.c >= opts.max) {
        res.setHeader("Retry-After", String(Math.ceil(opts.windowMs / 1000)));
        return res.status(429).json({ ok: false, error: "rate limit exceeded" });
      }
      db.prepare("INSERT INTO rate_limit_hits (bucket, key, ts) VALUES (?, ?, ?)")
        .run(opts.bucket, key, now);
    } catch {
      // fail-open on storage errors — do not wedge the service
    }
    return next();
  };
}

export function checkRateLimit(bucket: string, key: string, windowMs: number, max: number): boolean {
  init();
  const db = getDb();
  const now = Date.now();
  const cutoff = now - windowMs;
  try {
    db.prepare("DELETE FROM rate_limit_hits WHERE bucket=? AND key=? AND ts<?").run(bucket, key, cutoff);
    const row = db.prepare("SELECT COUNT(*) as c FROM rate_limit_hits WHERE bucket=? AND key=?")
      .get(bucket, key) as { c: number };
    if (row.c >= max) return false;
    db.prepare("INSERT INTO rate_limit_hits (bucket, key, ts) VALUES (?, ?, ?)").run(bucket, key, now);
    return true;
  } catch { return true; }
}
