/**
 * Centralized filesystem layout. Every module that reads or writes
 * runtime state (config/, data/, logs/, sessions/, ...) should resolve
 * its paths through this module instead of `process.cwd()`.
 *
 * Two roots:
 *   - DATA_DIR  — user-writable state (config/, data/, logs/, sessions/,
 *                 uploads/, output/, memory/, sandbox/, skills_pending/,
 *                 backups/). Defaults to `process.cwd()` when unset, which
 *                 matches the legacy behavior for Docker (cwd=/app) and
 *                 dev runs (cwd=repo root). Electron sets this to the OS
 *                 per-user appData dir.
 *   - APP_ROOT  — read-only shipped resources (public/, dist/, skills/
 *                 when not overridden by SKILLS_ROOT). Defaults to
 *                 `process.cwd()`.
 *
 * Setting DATA_DIR explicitly is the recommended way to deploy under
 * systemd or any runner that doesn't anchor cwd — it removes the cwd
 * footgun without forcing a `WorkingDirectory=` directive.
 */

import path from "path";
import { existsSync, mkdirSync } from "fs";

const DATA_DIR = process.env.DATA_DIR || process.cwd();
const APP_ROOT = process.env.APP_ROOT || process.cwd();

// `paths.data(...)` mirrors `db.ts/resolveDbPath`:
//   - when DATA_DIR is set (Electron, systemd) the SQLite DB and adjacent
//     blobs live directly in DATA_DIR (no `data/` subdir).
//   - in dev (no DATA_DIR), they live in `<cwd>/data/` as before.
// Other directories (config, logs, sessions, …) are always under DATA_DIR.
const DB_DIR = process.env.DATA_DIR ? DATA_DIR : path.join(DATA_DIR, "data");

export const paths = {
  dataDir: DATA_DIR,
  appRoot: APP_ROOT,
  config: (...rest: string[]) => path.join(DATA_DIR, "config", ...rest),
  data: (...rest: string[]) => path.join(DB_DIR, ...rest),
  logs: (...rest: string[]) => path.join(DATA_DIR, "logs", ...rest),
  sessions: (...rest: string[]) => path.join(DATA_DIR, "sessions", ...rest),
  uploads: (...rest: string[]) => path.join(DATA_DIR, "uploads", ...rest),
  output: (...rest: string[]) => path.join(DATA_DIR, "output", ...rest),
  memory: (...rest: string[]) => path.join(DATA_DIR, "memory", ...rest),
  sandbox: (...rest: string[]) => path.join(DATA_DIR, "sandbox", ...rest),
  skillsPending: (...rest: string[]) => path.join(DATA_DIR, "skills_pending", ...rest),
  backups: (...rest: string[]) => path.join(DATA_DIR, "backups", ...rest),
  hub: (...rest: string[]) => path.join(DATA_DIR, "hub", ...rest),
  public: (...rest: string[]) => path.join(APP_ROOT, "public", ...rest),
};

export function ensureDir(p: string): string {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
  return p;
}
