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

// Resolve roots lazily on every call. Capturing them at module load time
// breaks Electron's main process: ESM hoisting evaluates this module before
// main.ts can set process.env.DATA_DIR, so a captured DATA_DIR would be the
// (wrong) launch cwd of the .exe instead of app.getPath("userData").
const dataDir = (): string => process.env.DATA_DIR || process.cwd();
const appRoot = (): string => process.env.APP_ROOT || process.cwd();

// `paths.data(...)` mirrors `db.ts/resolveDbPath`:
//   - when DATA_DIR is set (Electron, systemd) the SQLite DB and adjacent
//     blobs live directly in DATA_DIR (no `data/` subdir).
//   - in dev (no DATA_DIR), they live in `<cwd>/data/` as before.
// Other directories (config, logs, sessions, …) are always under DATA_DIR.
const dbDir = (): string => process.env.DATA_DIR ? dataDir() : path.join(dataDir(), "data");

export const paths = {
  get dataDir() { return dataDir(); },
  get appRoot() { return appRoot(); },
  config: (...rest: string[]) => path.join(dataDir(), "config", ...rest),
  data: (...rest: string[]) => path.join(dbDir(), ...rest),
  logs: (...rest: string[]) => path.join(dataDir(), "logs", ...rest),
  sessions: (...rest: string[]) => path.join(dataDir(), "sessions", ...rest),
  uploads: (...rest: string[]) => path.join(dataDir(), "uploads", ...rest),
  output: (...rest: string[]) => path.join(dataDir(), "output", ...rest),
  memory: (...rest: string[]) => path.join(dataDir(), "memory", ...rest),
  sandbox: (...rest: string[]) => path.join(dataDir(), "sandbox", ...rest),
  skillsPending: (...rest: string[]) => path.join(dataDir(), "skills_pending", ...rest),
  backups: (...rest: string[]) => path.join(dataDir(), "backups", ...rest),
  hub: (...rest: string[]) => path.join(dataDir(), "hub", ...rest),
  public: (...rest: string[]) => path.join(appRoot(), "public", ...rest),
};

export function ensureDir(p: string): string {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
  return p;
}
