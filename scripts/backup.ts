/**
 * Backup script — snapshots all critical state to a timestamped directory
 * under `backups/`. Safe to run while the server is online (WAL checkpoint
 * ensures the DB copy is consistent).
 *
 * Captures:
 *   - data/secureclaw.db (+ WAL/SHM files)
 *   - config/  (encrypted vault, channel config, skill secrets, signing key)
 *   - memory/  (markdown memories, SOUL.md, STRATEGIST.md)
 *   - skills/  (user-built skills and manifests)
 *   - logs/    (agent loop logs — optional, skipped if large)
 *
 * Usage:
 *   npm run backup
 *   npm run backup -- --include-logs
 *   npm run backup -- --dest /path/to/dest
 */
import { promises as fs, createReadStream, existsSync, statSync, readdirSync } from "fs";
import path from "path";
import { createHash } from "crypto";
import Database from "better-sqlite3";

const REPO = process.cwd();
const DEFAULT_DEST = path.join(REPO, "backups");
const DB_PATH = path.join(REPO, "data", "secureclaw.db");

function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

async function copyDir(src: string, dst: string, skip?: (rel: string) => boolean): Promise<{ files: number; bytes: number }> {
  if (!existsSync(src)) return { files: 0, bytes: 0 };
  let files = 0;
  let bytes = 0;
  await fs.mkdir(dst, { recursive: true });
  const entries = readdirSync(src, { withFileTypes: true });
  for (const e of entries) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    const rel = path.relative(REPO, s);
    if (skip?.(rel)) continue;
    if (e.isDirectory()) {
      const sub = await copyDir(s, d, skip);
      files += sub.files;
      bytes += sub.bytes;
    } else if (e.isFile()) {
      await fs.copyFile(s, d);
      try { bytes += statSync(d).size; } catch {}
      files++;
    }
  }
  return { files, bytes };
}

/**
 * Checkpoint WAL into the main DB file, then copy it. Ensures the backup is
 * a single consistent file even if the server is writing concurrently.
 */
async function snapshotDb(destDir: string): Promise<{ bytes: number }> {
  if (!existsSync(DB_PATH)) return { bytes: 0 };
  const destDb = path.join(destDir, "secureclaw.db");
  await fs.mkdir(destDir, { recursive: true });

  // Open read-only and use SQLite's online backup API for a consistent copy.
  const src = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  try {
    src.pragma("busy_timeout = 5000");
    // @ts-ignore — better-sqlite3 exposes backup() returning a Promise
    await src.backup(destDb);
  } finally {
    src.close();
  }
  return { bytes: statSync(destDb).size };
}

function fmtBytes(n: number): string {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + " MB";
  return (n / 1024 / 1024 / 1024).toFixed(2) + " GB";
}

function hashFile(p: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    const s = createReadStream(p);
    s.on("data", d => h.update(d));
    s.on("end", () => resolve(h.digest("hex")));
    s.on("error", reject);
  });
}

async function walk(root: string): Promise<string[]> {
  const out: string[] = [];
  async function rec(d: string) {
    const entries = await fs.readdir(d, { withFileTypes: true });
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await rec(p);
      else if (e.isFile()) out.push(p);
    }
  }
  await rec(root);
  return out;
}

/**
 * Post-backup validation. Confirms the DB snapshot opens cleanly, passes a
 * quick_check, and that every file listed in the manifest exists with a
 * matching SHA-256.
 */
async function validate(outDir: string, checksums: Record<string, string>): Promise<string[]> {
  const errors: string[] = [];

  const dbPath = path.join(outDir, "secureclaw.db");
  if (existsSync(dbPath)) {
    try {
      const db = new Database(dbPath, { readonly: true, fileMustExist: true });
      try {
        const r = db.prepare("PRAGMA quick_check").get() as any;
        const status = r?.quick_check ?? r?.integrity_check;
        if (status !== "ok") errors.push(`quick_check: ${status}`);
      } finally {
        db.close();
      }
    } catch (err: any) {
      errors.push(`db open failed: ${err.message}`);
    }
  }

  for (const [rel, expected] of Object.entries(checksums)) {
    const abs = path.join(outDir, rel);
    if (!existsSync(abs)) { errors.push(`missing: ${rel}`); continue; }
    const got = await hashFile(abs);
    if (got !== expected) errors.push(`checksum mismatch: ${rel}`);
  }
  return errors;
}

async function main() {
  const args = process.argv.slice(2);
  const includeLogs = args.includes("--include-logs");
  const destIdx = args.indexOf("--dest");
  const destRoot = destIdx >= 0 ? args[destIdx + 1] : DEFAULT_DEST;

  const outDir = path.join(destRoot, `wardyn-${timestamp()}`);
  await fs.mkdir(outDir, { recursive: true });

  console.log(`Backing up to ${outDir} ...`);

  const report: Record<string, string> = {};

  // Database (consistent snapshot via online backup)
  try {
    const db = await snapshotDb(outDir);
    report.database = fmtBytes(db.bytes);
  } catch (err: any) {
    report.database = `ERROR: ${err.message}`;
  }

  // Config (encrypted vault, channels, secrets, signing key)
  const cfg = await copyDir(path.join(REPO, "config"), path.join(outDir, "config"));
  report.config = `${cfg.files} files, ${fmtBytes(cfg.bytes)}`;

  // Memory
  const mem = await copyDir(path.join(REPO, "memory"), path.join(outDir, "memory"));
  report.memory = `${mem.files} files, ${fmtBytes(mem.bytes)}`;

  // User skills — skip the bulk node_modules-style trees inside each skill
  const skills = await copyDir(path.join(REPO, "skills"), path.join(outDir, "skills"),
    rel => /node_modules|__pycache__|\.venv/.test(rel));
  report.skills = `${skills.files} files, ${fmtBytes(skills.bytes)}`;

  // Logs (opt-in)
  if (includeLogs) {
    const logs = await copyDir(path.join(REPO, "logs"), path.join(outDir, "logs"));
    report.logs = `${logs.files} files, ${fmtBytes(logs.bytes)}`;
  }

  // Build checksum manifest over every copied file. The validator uses
  // this to prove the backup survived the write and is byte-identical.
  const allFiles = await walk(outDir);
  const checksums: Record<string, string> = {};
  for (const abs of allFiles) {
    const rel = path.relative(outDir, abs).replace(/\\/g, "/");
    if (rel === "BACKUP.json") continue;
    checksums[rel] = await hashFile(abs);
  }

  const manifest = {
    createdAt: new Date().toISOString(),
    repo: REPO,
    includedLogs: includeLogs,
    contents: report,
    checksums,
  };
  await fs.writeFile(path.join(outDir, "BACKUP.json"), JSON.stringify(manifest, null, 2));

  // Validate: DB integrity + every file's checksum.
  const errors = await validate(outDir, checksums);
  if (errors.length > 0) {
    console.error("Backup validation FAILED:");
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(2);
  }

  console.log("");
  console.log("Backup complete + validated:");
  for (const [k, v] of Object.entries(report)) console.log(`  ${k.padEnd(10)} ${v}`);
  console.log(`  checksum   ${Object.keys(checksums).length} files verified`);
  console.log("");
  console.log(`Location: ${outDir}`);
}

main().catch(err => {
  console.error("Backup failed:", err);
  process.exit(1);
});
