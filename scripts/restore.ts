/**
 * Restore script — restores a backup created by scripts/backup.ts into the
 * live repo. Refuses to run while the server is up unless --force is passed.
 *
 * Usage:
 *   npm run restore -- --from backups/secureclaw-2026-04-15-120000
 *   npm run restore -- --from <dir> --force
 */
import { promises as fs, existsSync, readdirSync, statSync } from "fs";
import path from "path";
import net from "net";

const REPO = process.cwd();

function portOpen(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise(resolve => {
    const s = net.createConnection({ port, host, timeout: 500 });
    s.on("connect", () => { s.end(); resolve(true); });
    s.on("timeout", () => { s.destroy(); resolve(false); });
    s.on("error", () => resolve(false));
  });
}

async function copyDir(src: string, dst: string): Promise<number> {
  if (!existsSync(src)) return 0;
  let n = 0;
  await fs.mkdir(dst, { recursive: true });
  for (const e of readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) n += await copyDir(s, d);
    else if (e.isFile()) { await fs.copyFile(s, d); n++; }
  }
  return n;
}

async function main() {
  const args = process.argv.slice(2);
  const fromIdx = args.indexOf("--from");
  const force = args.includes("--force");
  if (fromIdx < 0) {
    console.error("Usage: npm run restore -- --from <backup-dir> [--force]");
    process.exit(2);
  }
  const src = path.resolve(args[fromIdx + 1]);
  if (!existsSync(src)) { console.error(`Backup not found: ${src}`); process.exit(2); }

  const manifestPath = path.join(src, "BACKUP.json");
  if (!existsSync(manifestPath)) {
    console.error(`Missing BACKUP.json in ${src} — refusing to restore.`);
    process.exit(2);
  }
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  console.log(`Restoring from backup dated ${manifest.createdAt}`);

  const port = Number(process.env.PORT) || 3000;
  if (await portOpen(port) && !force) {
    console.error(`Server appears to be running on :${port}. Stop it first or pass --force.`);
    process.exit(1);
  }

  const dbSrc = path.join(src, "secureclaw.db");
  if (existsSync(dbSrc)) {
    const dbDst = path.join(REPO, "data", "secureclaw.db");
    await fs.mkdir(path.dirname(dbDst), { recursive: true });
    // Move existing db aside
    if (existsSync(dbDst)) await fs.rename(dbDst, dbDst + ".pre-restore-" + Date.now());
    await fs.copyFile(dbSrc, dbDst);
    console.log(`  db: ${statSync(dbDst).size} bytes`);
  }

  for (const sub of ["config", "memory", "skills", "logs"]) {
    const s = path.join(src, sub);
    if (!existsSync(s)) continue;
    const n = await copyDir(s, path.join(REPO, sub));
    console.log(`  ${sub}: ${n} files`);
  }

  console.log("Restore complete.");
}

main().catch(err => { console.error("Restore failed:", err); process.exit(1); });
