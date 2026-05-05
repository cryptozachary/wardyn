#!/usr/bin/env tsx
/**
 * myclaw doctor — validate install state.
 *
 * Runs a battery of checks, prints pass/warn/fail, exits non-zero on any
 * FAIL. Designed to be safe to run anytime (no mutating operations).
 *
 *   npm run doctor
 *   npm run doctor -- --json
 *   npm run doctor -- --reseed-audit   # rewrites the audit chain from GENESIS
 */
import { existsSync, statSync, readdirSync, readFileSync } from "fs";
import path from "path";
import dotenv from "dotenv";
import { getDb, closeDb } from "../src/db.js";
import { auditLogger } from "../src/security/auditLog.js";
import { loadKeys } from "../src/security/keyVault.js";
import { loadChannelConfig } from "../src/channels/channelConfig.js";
import { loadSkills } from "../src/skills/loader.js";
import { getProviderName, getModelConfig } from "../src/llm/router.js";

dotenv.config();

type Level = "ok" | "warn" | "fail" | "skip";
interface Check { name: string; level: Level; detail: string; }
const results: Check[] = [];
const push = (name: string, level: Level, detail: string) => results.push({ name, level, detail });

function check(name: string, fn: () => { level: Level; detail: string } | Promise<{ level: Level; detail: string }>) {
  return Promise.resolve(fn()).then(r => push(name, r.level, r.detail), e => push(name, "fail", e.message));
}

function fmtBytes(n: number): string {
  const u = ["B", "KB", "MB", "GB"]; let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(1)} ${u[i]}`;
}

async function main() {
  const cwd = process.cwd();

  if (process.argv.includes("--reseed-audit")) {
    const { fixed, total } = auditLogger.reseedChain();
    console.log(`audit chain reseed: rewrote ${fixed}/${total} event(s) from GENESIS`);
    closeDb();
    process.exit(0);
  }

  await check("working dir", () => {
    const pkg = path.join(cwd, "package.json");
    if (!existsSync(pkg)) return { level: "fail", detail: `no package.json at ${cwd}` };
    const j = JSON.parse(readFileSync(pkg, "utf8"));
    return { level: "ok", detail: `${j.name} v${j.version}` };
  });

  await check("node version", () => {
    const major = Number(process.versions.node.split(".")[0]);
    if (major < 20) return { level: "fail", detail: `node ${process.versions.node} (<20)` };
    if (major < 22) return { level: "warn", detail: `node ${process.versions.node} (22+ recommended)` };
    return { level: "ok", detail: `node ${process.versions.node}` };
  });

  await check("data dir", () => {
    const d = path.join(cwd, "data");
    if (!existsSync(d)) return { level: "warn", detail: "data/ missing — will be created on first start" };
    return { level: "ok", detail: path.basename(d) };
  });

  await check("sqlite database", () => {
    try {
      const db = getDb();
      const n = (db.prepare("SELECT COUNT(*) c FROM sessions").get() as any).c;
      const size = existsSync(path.join(cwd, "data", "secureclaw.db"))
        ? fmtBytes(statSync(path.join(cwd, "data", "secureclaw.db")).size)
        : "?";
      return { level: "ok", detail: `${n} sessions, db=${size}` };
    } catch (e: any) { return { level: "fail", detail: e.message }; }
  });

  await check("audit chain", () => {
    try {
      const r = auditLogger.verifyChain();
      if (r.totalChecked === 0) return { level: "ok", detail: "no events yet" };
      if (!r.valid) return { level: "fail", detail: `${r.brokenLinks.length} broken link(s) of ${r.totalChecked}` };
      return { level: "ok", detail: `${r.totalChecked} events, chain valid` };
    } catch (e: any) { return { level: "fail", detail: e.message }; }
  });

  await check("key vault", () => {
    const vault = path.join(cwd, "config", "providers.enc");
    if (!existsSync(vault)) return { level: "warn", detail: "not initialized — run npm run store-key" };
    const pp = process.env.KEY_PASSPHRASE;
    if (!pp) return { level: "warn", detail: "KEY_PASSPHRASE not set — vault cannot be read" };
    try {
      const keys = loadKeys(pp);
      const names = Object.keys(keys).filter(k => !k.startsWith("channel:"));
      return { level: "ok", detail: `${names.length} provider key(s): ${names.join(", ") || "(none)"}` };
    } catch (e: any) { return { level: "fail", detail: `decrypt failed: ${e.message}` }; }
  });

  await check("llm provider", () => {
    const p = getProviderName();
    const models = getModelConfig();
    return { level: "ok", detail: `${p} (model=${models[p] ?? "?"})` };
  });

  await check("api token", () => {
    if (process.env.API_TOKEN) return { level: "ok", detail: "API_TOKEN set" };
    return { level: "warn", detail: "API_TOKEN not set — HTTP endpoints are unauthenticated" };
  });

  await check("channels", () => {
    const cfg = loadChannelConfig();
    const active: string[] = [];
    if (cfg.telegram?.botToken) active.push("telegram");
    if (cfg.discord?.botToken) active.push("discord");
    if (cfg.slack?.botToken) active.push("slack");
    if (process.env.WHATSAPP_ENABLED === "1") active.push("whatsapp(opt-in)");
    if (active.length === 0) return { level: "warn", detail: "no channels configured" };
    return { level: "ok", detail: active.join(", ") };
  });

  await check("skills", () => {
    try {
      const s = loadSkills();
      const missingExec = s.filter(x => !x.execute).map(x => x.name);
      if (missingExec.length > 0) return { level: "warn", detail: `${s.length} loaded, ${missingExec.length} without execute(): ${missingExec.slice(0,5).join(", ")}` };
      return { level: "ok", detail: `${s.length} skills loaded` };
    } catch (e: any) { return { level: "fail", detail: e.message }; }
  });

  await check("signing keypair", () => {
    const pp = process.env.KEY_PASSPHRASE;
    if (!pp) return { level: "warn", detail: "KEY_PASSPHRASE not set — cannot inspect vault" };
    try {
      const keys = loadKeys(pp);
      const hasPriv = !!keys["_signing:private"];
      const hasPub = !!keys["_signing:public"];
      if (hasPriv && hasPub) return { level: "ok", detail: "Ed25519 keypair in vault" };
      return { level: "warn", detail: "not generated (gateway creates on first boot)" };
    } catch (e: any) { return { level: "fail", detail: `vault read failed: ${e.message}` }; }
  });

  await check("memory files", () => {
    const memDir = path.join(cwd, "memory");
    if (!existsSync(memDir)) return { level: "warn", detail: "memory/ missing" };
    const soul = existsSync(path.join(memDir, "SOUL.md"));
    const memory = existsSync(path.join(memDir, "MEMORY.md"));
    if (!soul) return { level: "warn", detail: "SOUL.md missing" };
    if (!memory) return { level: "warn", detail: "MEMORY.md missing" };
    return { level: "ok", detail: "SOUL.md + MEMORY.md present" };
  });

  await check("disk usage", () => {
    let total = 0, files = 0;
    const walk = (p: string) => {
      try {
        for (const e of readdirSync(p, { withFileTypes: true })) {
          if (e.name === "node_modules" || e.name === ".git") continue;
          const full = path.join(p, e.name);
          if (e.isDirectory()) walk(full);
          else { try { total += statSync(full).size; files++; } catch {} }
        }
      } catch {}
    };
    for (const d of ["data", "logs", "sessions", "uploads", "output", "backups"]) {
      const dir = path.join(cwd, d);
      if (existsSync(dir)) walk(dir);
    }
    return { level: "ok", detail: `${files} files, ${fmtBytes(total)}` };
  });

  await check("uploads dir", () => {
    const d = path.join(cwd, "uploads");
    if (!existsSync(d)) return { level: "ok", detail: "not yet created" };
    const files = readdirSync(d).length;
    return { level: "ok", detail: `${files} pending upload(s)` };
  });

  await check("quota tracker", () => {
    try {
      const db = getDb();
      const recent = (db.prepare(
        "SELECT COUNT(*) c FROM quota_events WHERE ts > ?"
      ).get(Date.now() - 3600_000) as any).c;
      return { level: "ok", detail: `${recent} quota event(s) in last hour` };
    } catch (e: any) { return { level: "warn", detail: e.message }; }
  });

  const json = process.argv.includes("--json");
  if (json) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    const icons: Record<Level, string> = { ok: "[ OK ]", warn: "[WARN]", fail: "[FAIL]", skip: "[SKIP]" };
    console.log("\nmyclaw doctor\n");
    for (const r of results) {
      console.log(`  ${icons[r.level]}  ${r.name.padEnd(22)}  ${r.detail}`);
    }
    const pass = results.filter(r => r.level === "ok").length;
    const warn = results.filter(r => r.level === "warn").length;
    const fail = results.filter(r => r.level === "fail").length;
    console.log(`\n  summary: ${pass} ok, ${warn} warn, ${fail} fail\n`);
  }

  closeDb();
  process.exit(results.some(r => r.level === "fail") ? 1 : 0);
}

main().catch(err => {
  console.error("doctor crashed:", err);
  process.exit(2);
});
