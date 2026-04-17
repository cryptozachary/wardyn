import express from "express";
import bodyParser from "body-parser";
import path from "path";
import fs from "fs";
import { loadSkills } from "./skills/loader.js";
import { runAgentLoop } from "./orchestrator/agentLoop.js";
import { Message } from "./types.js";
import { loadKeys, storeKey } from "./security/keyVault.js";
import { sendTelegramReply, extractChatId } from "./channels/telegram.js";
import { sendDiscordReply, extractChannelId, startDiscordBot, isDiscordBotRunning } from "./channels/discord.js";
import { startWhatsapp, isWhatsappRunning } from "./channels/whatsapp.js";
import { sendSlackReply, extractSlackChannelId, isSlackBotMessage, isSlackUrlVerification, isSlackMessageEvent, getSlackSigningSecret, verifySlackSignature } from "./channels/slack.js";
import { loadChannelConfig, saveChannelConfig, getMaskedConfig, clearChannelConfigCache, migrateChannelSecrets } from "./channels/channelConfig.js";
import { attachWebSocket } from "./channels/websocket.js";
import { loadHeartbeatConfig, startHeartbeat, type HeartbeatController } from "./orchestrator/heartbeat.js";
import { seedFromJson, listJobs, getJob, createJob, updateJob, deleteJob } from "./orchestrator/heartbeatStore.js";
import { listSessions, loadSession, cleanExpiredSessions, searchSessions, setThinkingLevel, THINKING_LEVELS, type ThinkingLevel } from "./orchestrator/sessionStore.js";
import { pushCanvas, listCanvas, getCanvas, clearCanvas, type CanvasKind } from "./orchestrator/canvasStore.js";
import { getProviderName, setProviderName, getModelConfig, setModel } from "./llm/router.js";
import { buildSkill } from "./builder/builderAgent.js";
import { deleteSkill, isProtected } from "./builder/skillWriter.js";
import { auditLogger } from "./security/auditLog.js";
import { exportSkill, importSkill, importFromUrl, listPackages, getPackage, deletePackage } from "./hub/hubManager.js";
import { getMaskedSecrets, setSkillSecret, deleteSkillSecret, initSkillSecrets, migrateLegacySecrets } from "./security/skillSecrets.js";
import { getPublicKey, ensureKeypair } from "./security/skillSigning.js";
import { getLoopGuardStats } from "./security/loopGuard.js";
import { ZeroizingCache } from "./security/zeroize.js";
import { safeStatic } from "./security/pathGuard.js";
import { getAllQuotas, getQuotaStatus } from "./security/quotaTracker.js";
import { submitForApproval, approveSkill, rejectSkill, listApprovals, getApproval, isApprovalRequired } from "./security/approvalQueue.js";
import { checkPairing, pairingMessage, approveByCode, approve as approvePairing, revoke as revokePairing, listPairings, type Channel as PairingChannel } from "./security/pairingGuard.js";
import { assertCodeSafe } from "./security/astAnalyzer.js";
import { upload, fileToAttachment, cleanExpiredUploads, UPLOADS_DIR } from "./uploads/uploadHandler.js";
import { createServer } from "http";
import { getDb, closeDb } from "./db.js";
import dotenv from "dotenv";
import os from "os";
import {
  requireAuth,
  requireCsrf,
  authForBrowser,
  isAuthenticated,
  issueSessionCookie,
  clearSessionCookie,
  validateApiToken,
  assertProdAuthConfig,
} from "./security/auth.js";
import { verifyDiscordSignature } from "./channels/discord.js";
import { sqliteRateLimit } from "./security/rateLimit.js";
import { log, requestLogger as requestLoggerMiddleware, snapshotMetrics } from "./security/logger.js";
dotenv.config();

assertProdAuthConfig();

const APP_ROOT = process.env.APP_ROOT || process.cwd();
const BOOT_START = Date.now();

// Initialize SQLite database (creates tables on first run)
getDb();

const app = express();
app.set("trust proxy", process.env.TRUST_PROXY || "loopback");
app.use(requestLoggerMiddleware());
app.use(bodyParser.json({
  limit: process.env.BODY_LIMIT || "1mb",
  verify: (req: any, _res, buf) => { req.rawBody = buf.toString(); },
}));
const skills = loadSkills();

function reloadSkills() {
  const fresh = loadSkills();
  skills.length = 0;
  skills.push(...fresh);
}
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "127.0.0.1";
const API_TOKEN = process.env.API_TOKEN;

// Auto-zeroizing key cache: decrypted keys are wiped from memory after 60s of inactivity
const keyCache = new ZeroizingCache(
  () => loadKeys(process.env.KEY_PASSPHRASE ?? ""),
  60_000,
);
function getKeys(): Record<string, string> {
  return keyCache.get();
}

function getProviderKey(): string {
  const provider = getProviderName();
  const keys = getKeys();
  if (provider === "ollama") return "ollama-local";
  const key = keys[provider] ?? keys["openai"] ?? "";
  if (!key) {
    console.warn(`[gateway] No API key found for provider "${provider}". Vault may be empty or passphrase mismatch. LLM calls will fall back to Ollama.`);
  }
  return key;
}

const RATE_MAX = Number(process.env.RATE_LIMIT) || 30;
const rateLimit = sqliteRateLimit({ windowMs: 60_000, max: RATE_MAX, bucket: "http" });

// Security headers on every response
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' ws://127.0.0.1:* wss://127.0.0.1:*; font-src 'self'; frame-ancestors 'none'"
  );
  if (process.env.NODE_ENV === "production" || process.env.ENABLE_HSTS === "true") {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  next();
});

// --- Public/admin listener split ---
// Admin port hosts /api/*, /ui, /chat, /canvas, /output, /ws management.
// Public port hosts /webhook/*, /health, /ws chat.
const ADMIN_PORT = Number(process.env.ADMIN_PORT) || 0; // 0 = same listener as public
const ADMIN_HOST = process.env.ADMIN_HOST || "127.0.0.1";
const ADMIN_ONLY_PREFIXES = ["/api/", "/ui", "/chat", "/canvas", "/output", "/uploads", "/login"];
const PUBLIC_ONLY_PREFIXES = ["/webhook/"];

function isAdminOnly(url: string): boolean {
  return ADMIN_ONLY_PREFIXES.some(p => url === p || url.startsWith(p + (p.endsWith("/") ? "" : "/")) || url.startsWith(p + "?"));
}
function isPublicOnly(url: string): boolean {
  return PUBLIC_ONLY_PREFIXES.some(p => url.startsWith(p));
}

app.use((req, res, next) => {
  if (!ADMIN_PORT) return next();
  const port = (req.socket as any).localPort as number | undefined;
  const onAdmin = port === ADMIN_PORT;
  if (onAdmin && isPublicOnly(req.path)) return res.status(404).json({ ok: false, error: "not found" });
  if (!onAdmin && isAdminOnly(req.path)) return res.status(404).json({ ok: false, error: "not found" });
  next();
});

// --- Auth routes (must precede gated routes) ---
app.get("/login", (_req, res) => res.sendFile(path.join(APP_ROOT, "public", "login.html")));
// Login is pre-CSRF because it is how a session is first established.
app.post("/api/auth/login", rateLimit, (req, res) => {
  const { token } = req.body || {};
  if (typeof token !== "string" || !validateApiToken(token)) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  issueSessionCookie(res);
  res.json({ ok: true });
});
// Status check — GET, no side effects, no CSRF needed.
app.get("/api/auth/status", (req, res) => {
  res.json({ ok: true, authenticated: isAuthenticated(req) });
});

// CSRF enforcement on cookie-auth mutating requests (must precede mutating /api/* routes)
app.use("/api", requireCsrf);

// Logout post-CSRF so forced-logout via CSRF is blocked.
app.post("/api/auth/logout", (_req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

// Serve static UI with path traversal protection (auth-gated)
app.use("/ui", authForBrowser, ...safeStatic(path.join(APP_ROOT, "public")));
app.get("/chat", authForBrowser, (_req, res) => res.sendFile(path.join(APP_ROOT, "public", "chat.html")));
app.get("/canvas", authForBrowser, (_req, res) => res.sendFile(path.join(APP_ROOT, "public", "canvas.html")));

// Serve skill output files with path traversal protection (auth-gated)
app.use("/output", authForBrowser, ...safeStatic(path.join(process.cwd(), "output")));
function normalizeTelegram(body: any): Message {
  return { id: String(body.update_id ?? Date.now()), channel: "telegram", userId: String(body.message?.from?.id ?? "unknown"), text: body.message?.text ?? "", ts: Date.now() };
}
function normalizeDiscord(body: any): Message {
  return { id: body.id ?? String(Date.now()), channel: "discord", userId: body.author?.id ?? "unknown", text: body.content ?? "", ts: Date.now() };
}
function normalizeSlack(body: any): Message {
  const evt = body.event ?? {};
  return { id: evt.client_msg_id ?? String(Date.now()), channel: "slack", userId: evt.user ?? "unknown", text: evt.text ?? "", ts: Date.now() };
}

// --- Setup & configuration endpoints ---
app.get("/api/setup/status", requireAuth, (_req, res) => {
  const vaultPath = path.join(process.cwd(), "config", "providers.enc");
  res.json({ hasVault: fs.existsSync(vaultPath) });
});

app.post("/api/setup/store-key", requireAuth, (req, res) => {
  const { passphrase, provider, key, openaiKey } = req.body || {};
  // Support both new format { provider, key } and legacy { openaiKey }
  const providerName = provider || "openai";
  const apiKey = key || openaiKey;
  if (!passphrase || !apiKey) {
    return res.status(400).json({ ok: false, error: "passphrase and key required" });
  }
  try {
    storeKey(providerName, apiKey, passphrase);
    keyCache.invalidate();
    res.json({ ok: true, provider: providerName });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- Provider switching ---
app.post("/api/setup/provider", requireAuth, (req, res) => {
  const { provider } = req.body || {};
  if (!provider || typeof provider !== "string") {
    return res.status(400).json({ ok: false, error: "provider is required" });
  }
  try {
    setProviderName(provider);
    keyCache.invalidate(); // refresh key cache for new provider
    res.json({ ok: true, provider: getProviderName() });
  } catch (err: any) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// --- Model selection ---
app.get("/api/setup/models", requireAuth, (_req, res) => {
  res.json({ ok: true, models: getModelConfig() });
});

app.post("/api/setup/models", requireAuth, (req, res) => {
  const { provider, model } = req.body || {};
  if (!provider || !model) {
    return res.status(400).json({ ok: false, error: "provider and model are required" });
  }
  try {
    setModel(provider, model);
    res.json({ ok: true, provider, model });
  } catch (err: any) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// --- Ollama config ---
app.get("/api/ollama/config", requireAuth, (_req, res) => {
  const cfgPath = path.join(process.cwd(), "config", "ollama.json");
  try {
    if (fs.existsSync(cfgPath)) {
      res.json(JSON.parse(fs.readFileSync(cfgPath, "utf8")));
    } else {
      res.json({ url: process.env.OLLAMA_URL || "http://localhost:11434", model: process.env.OLLAMA_MODEL || "llama3.1" });
    }
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/ollama/config", requireAuth, (req, res) => {
  const { url, model } = req.body || {};
  if (!url || typeof url !== "string") {
    return res.status(400).json({ ok: false, error: "url is required" });
  }
  try {
    const cfgDir = path.join(process.cwd(), "config");
    if (!fs.existsSync(cfgDir)) fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(path.join(cfgDir, "ollama.json"), JSON.stringify({ url, model: model || "llama3.1" }, null, 2), "utf8");
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/ollama/ping", requireAuth, async (req, res) => {
  const { url } = req.body || {};
  const target = url || "http://localhost:11434";
  try {
    const r = await fetch(`${target}/api/tags`);
    const data = await r.json() as { models?: { name: string }[] };
    const models = (data.models || []).map((m) => m.name);
    res.json({ ok: true, models });
  } catch (err: any) {
    res.json({ ok: false, error: err.message, models: [] });
  }
});

app.get("/api/memory", requireAuth, (_req, res) => {
  try {
    const memory = fs.readFileSync(path.join(process.cwd(), "memory", "MEMORY.md"), "utf8");
    const soul = fs.readFileSync(path.join(process.cwd(), "memory", "SOUL.md"), "utf8");
    res.json({ memory, soul });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/memory", requireAuth, (req, res) => {
  const { memory, soul } = req.body || {};
  if (typeof memory !== "string" || typeof soul !== "string") {
    return res.status(400).json({ ok: false, error: "memory and soul must be strings" });
  }
  try {
    fs.writeFileSync(path.join(process.cwd(), "memory", "MEMORY.md"), memory, "utf8");
    fs.writeFileSync(path.join(process.cwd(), "memory", "SOUL.md"), soul, "utf8");
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});
// --- Skill Builder endpoints ---
app.get("/api/skills", requireAuth, (_req, res) => {
  res.json({
    skills: skills.map(s => ({
      name: s.name,
      description: s.description,
      hasExecute: !!s.execute,
      secrets: s.secrets,
    })),
  });
});

app.post("/api/skills/build", rateLimit, requireAuth, async (req, res) => {
  const { prompt, language, overwrite, testArgs } = req.body || {};
  if (!prompt || typeof prompt !== "string") {
    return res.status(400).json({ ok: false, error: "prompt is required" });
  }
  try {
    const apiKey = getProviderKey();
    const result = await buildSkill({ prompt, language }, apiKey, overwrite === true, testArgs);

    if (!result.success && result.validationOutput.includes("already exists")) {
      return res.json({ ok: false, error: "skill_exists", name: result.name, message: result.validationOutput });
    }

    if (result.success) {
      // If approval queue is enabled, route through approval instead of direct activation
      if (isApprovalRequired()) {
        // Run AST analysis for the approval review
        const astResult = await assertCodeSafe(result.code, result.language);
        // Delete the skill that buildSkill() already wrote (it'll be re-installed on approval)
        try { deleteSkill(result.name); } catch {}
        const approval = submitForApproval(result, "build", astResult.warnings);
        return res.json({
          ok: true,
          requiresApproval: true,
          approvalId: approval.id,
          skillName: result.name,
          astWarnings: astResult.warnings,
          skill: result,
        });
      }
      reloadSkills();
    }
    res.json({ ok: result.success, skill: result });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete("/api/skills/:name", requireAuth, (req, res) => {
  const { name } = req.params;
  if (isProtected(name)) {
    return res.status(403).json({ ok: false, error: `Cannot delete protected skill: ${name}` });
  }
  try {
    deleteSkill(name);
    reloadSkills();
    res.json({ ok: true });
  } catch (err: any) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// --- Hub endpoints ---
app.get("/api/hub/packages", requireAuth, (_req, res) => {
  res.json({ ok: true, packages: listPackages() });
});

app.post("/api/hub/export", requireAuth, (req, res) => {
  const { name, version, author } = req.body || {};
  if (!name) return res.status(400).json({ ok: false, error: "name is required" });
  try {
    const pkg = exportSkill(name, author || "anonymous", version);
    res.json({ ok: true, package: pkg });
  } catch (err: any) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post("/api/hub/import", requireAuth, async (req, res) => {
  const smokeTestFlag = req.query.smokeTest === "true";
  try {
    // If approval required, validate but don't install — route to queue
    if (isApprovalRequired() && req.body?.code) {
      const pkg = req.body;
      const astResult = await assertCodeSafe(pkg.code, pkg.language || "typescript");
      const builderResult = {
        name: pkg.name, language: pkg.language || "typescript",
        description: pkg.description || pkg.name, parameters: pkg.parameters || {},
        secrets: undefined, code: pkg.code, wrapperCode: pkg.wrapperCode,
        skillMd: pkg.skillMd || pkg.description || pkg.name,
        validationOutput: "", success: true, attempts: 1, sampleArgs: pkg.sampleArgs,
      };
      const approval = submitForApproval(builderResult, "import", astResult.warnings, pkg.author);
      return res.json({
        ok: true, requiresApproval: true,
        approvalId: approval.id, skillName: pkg.name,
        astWarnings: astResult.warnings,
      });
    }
    const result = await importSkill(req.body, smokeTestFlag);
    if (result.success) reloadSkills();
    res.json({ ok: result.success, error: result.error });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/hub/import-url", requireAuth, async (req, res) => {
  const { url, smokeTest } = req.body || {};
  if (!url) return res.status(400).json({ ok: false, error: "url is required" });
  try {
    const result = await importFromUrl(url, smokeTest === true);
    if (result.success) reloadSkills();
    res.json({ ok: result.success, error: result.error });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/hub/packages/:name", rateLimit, (req, res) => {
  const pkg = getPackage(req.params.name);
  if (!pkg) return res.status(404).json({ ok: false, error: "Package not found" });
  res.json(pkg);
});

app.delete("/api/hub/packages/:name", requireAuth, (req, res) => {
  try {
    deletePackage(req.params.name);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// --- Skill Approval Queue endpoints ---
app.get("/api/approvals", requireAuth, (req, res) => {
  const status = req.query.status as "pending" | "approved" | "rejected" | undefined;
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const offset = Number(req.query.offset) || 0;
  const all = listApprovals(status);
  res.json({ ok: true, approvals: all.slice(offset, offset + limit), total: all.length });
});

app.get("/api/approvals/:id", requireAuth, (req, res) => {
  const approval = getApproval(req.params.id);
  if (!approval) return res.status(404).json({ ok: false, error: "Approval not found" });
  res.json({ ok: true, approval });
});

app.post("/api/approvals/:id/approve", requireAuth, (req, res) => {
  const result = approveSkill(req.params.id);
  if (result.ok) reloadSkills();
  res.json(result);
});

app.post("/api/approvals/:id/reject", requireAuth, (req, res) => {
  const { reason } = req.body || {};
  const result = rejectSkill(req.params.id, reason);
  res.json(result);
});

app.get("/api/approvals/config/status", requireAuth, (_req, res) => {
  res.json({ ok: true, approvalRequired: isApprovalRequired() });
});

// --- Skill Secrets endpoints ---
app.get("/api/skill-secrets", requireAuth, (_req, res) => {
  res.json({ ok: true, secrets: getMaskedSecrets() });
});

app.post("/api/skill-secrets", requireAuth, (req, res) => {
  const { skill, key, value, passphrase } = req.body || {};
  if (!skill || !key || typeof value !== "string") {
    return res.status(400).json({ ok: false, error: "skill, key, and value are required" });
  }
  if (!passphrase && !process.env.KEY_PASSPHRASE) {
    return res.status(400).json({ ok: false, error: "passphrase is required (vault is encrypted)" });
  }
  try {
    setSkillSecret(skill, key, value, passphrase);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.delete("/api/skill-secrets", requireAuth, (req, res) => {
  const { skill, key, passphrase } = req.body || {};
  if (!skill || !key) {
    return res.status(400).json({ ok: false, error: "skill and key are required" });
  }
  try {
    deleteSkillSecret(skill, key, passphrase);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post('/webhook/telegram', rateLimit, async (req, res) => {
  try {
    const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
    if (!expectedSecret) {
      return res.status(503).json({ ok: false, error: "telegram webhook secret not configured" });
    }
    if (req.get("x-telegram-bot-api-secret-token") !== expectedSecret) {
      return res.status(401).json({ ok: false, error: "invalid telegram secret" });
    }
    const chatId = extractChatId(req.body);
    const pairing = checkPairing("telegram", String(chatId || "unknown"));
    if (!pairing.approved) {
      if (chatId) {
        try { await sendTelegramReply(chatId, pairingMessage("telegram", pairing.code!)); } catch {}
      }
      return res.json({ ok: true, pairing: "required" });
    }
    const msg = normalizeTelegram(req.body);
    const key = getProviderKey();
    const result = await runAgentLoop(msg, skills, key, {
      sessionId: `telegram:${chatId}`
    });
    if (result.final) {
      if (chatId) {
        try { await sendTelegramReply(chatId, result.final); } catch {}
      }
    }
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});
app.post('/webhook/discord', rateLimit, async (req, res) => {
  try {
    const publicKey = process.env.DISCORD_PUBLIC_KEY;
    if (!publicKey) {
      return res.status(404).json({ ok: false, error: "not found" });
    }
    const sig = req.get("x-signature-ed25519") ?? "";
    const ts = req.get("x-signature-timestamp") ?? "";
    const raw = (req as any).rawBody ?? "";
    if (!verifyDiscordSignature(publicKey, sig, ts, raw)) {
      return res.status(401).json({ ok: false, error: "invalid discord signature" });
    }
    const channelId = extractChannelId(req.body);
    const pairing = checkPairing("discord", String(channelId || "unknown"));
    if (!pairing.approved) {
      if (channelId) {
        try { await sendDiscordReply(channelId, pairingMessage("discord", pairing.code!)); } catch {}
      }
      return res.json({ ok: true, pairing: "required" });
    }
    const msg = normalizeDiscord(req.body);
    const key = getProviderKey();
    const result = await runAgentLoop(msg, skills, key, {
      sessionId: `discord:${channelId}`
    });
    if (result.final) {
      if (channelId) {
        try { await sendDiscordReply(channelId, result.final); } catch {}
      }
    }
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- Slack webhook ---
// Dedup set to handle Slack's retry behavior (3-second timeout)
const processedSlackEvents = new Set<string>();
setInterval(() => { processedSlackEvents.clear(); }, 300_000).unref();

app.post('/webhook/slack', rateLimit, async (req, res) => {
  // URL verification challenge (Slack sends this during webhook setup)
  if (isSlackUrlVerification(req.body)) {
    return res.json({ challenge: req.body.challenge });
  }

  // Slack signature is mandatory — no optional bypass.
  const signingSecret = getSlackSigningSecret();
  if (!signingSecret) {
    return res.status(503).json({ ok: false, error: "slack signing secret not configured" });
  }
  const timestamp = req.get("x-slack-request-timestamp") ?? "";
  const signature = req.get("x-slack-signature") ?? "";
  const rawBody = (req as any).rawBody ?? "";
  if (!verifySlackSignature(signingSecret, timestamp, rawBody, signature)) {
    return res.status(401).json({ ok: false, error: "invalid signature" });
  }

  // Only process message events
  if (!isSlackMessageEvent(req.body)) {
    return res.status(200).json({ ok: true });
  }

  // Skip bot messages to prevent infinite loops
  if (isSlackBotMessage(req.body)) {
    return res.status(200).json({ ok: true });
  }

  // Deduplicate retries
  const eventId = req.body.event_id ?? req.body.event?.client_msg_id;
  if (eventId && processedSlackEvents.has(eventId)) {
    return res.status(200).json({ ok: true });
  }
  if (eventId) processedSlackEvents.add(eventId);

  try {
    const channelId = extractSlackChannelId(req.body);
    const userId = req.body.event?.user ?? "unknown";
    const pairKey = channelId ? `${channelId}:${userId}` : String(userId);
    const pairing = checkPairing("slack", pairKey);
    if (!pairing.approved) {
      if (channelId) {
        try { await sendSlackReply(channelId, pairingMessage("slack", pairing.code!)); } catch {}
      }
      return res.json({ ok: true, pairing: "required" });
    }
    const msg = normalizeSlack(req.body);
    const key = getProviderKey();
    const result = await runAgentLoop(msg, skills, key, {
      sessionId: `slack:${pairKey}`
    });
    if (result.final) {
      if (channelId) await sendSlackReply(channelId, result.final);
    }
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- Canvas endpoints ---
app.get("/api/canvas", requireAuth, (req, res) => {
  const session = req.query.session as string | undefined;
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  res.json({ ok: true, items: listCanvas(session, limit) });
});
app.get("/api/canvas/:id", requireAuth, (req, res) => {
  const item = getCanvas(req.params.id);
  if (!item) return res.status(404).json({ ok: false, error: "not found" });
  res.json({ ok: true, item });
});
app.post("/api/canvas", requireAuth, (req, res) => {
  const { session, kind, data, title } = req.body || {};
  if (!session || !kind || data === undefined) {
    return res.status(400).json({ ok: false, error: "session, kind, data required" });
  }
  try {
    const item = pushCanvas(session, kind as CanvasKind, data, title);
    res.json({ ok: true, item });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});
app.post("/api/canvas/clear", requireAuth, (req, res) => {
  const { session, all } = req.body || {};
  const deleted = clearCanvas(all ? undefined : session);
  res.json({ ok: true, deleted });
});

// --- Pairing endpoints ---
app.get("/api/pairings", requireAuth, (_req, res) => {
  res.json({ ok: true, pairings: listPairings() });
});

app.post("/api/pairings/approve", requireAuth, (req, res) => {
  const { code, channel, externalId } = req.body || {};
  try {
    if (code) {
      const p = approveByCode(String(code));
      if (!p) return res.status(404).json({ ok: false, error: "code not found or already approved" });
      return res.json({ ok: true, pairing: p });
    }
    if (channel && externalId) {
      const p = approvePairing(channel as PairingChannel, String(externalId));
      return res.json({ ok: true, pairing: p });
    }
    res.status(400).json({ ok: false, error: "provide { code } or { channel, externalId }" });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/pairings/revoke", requireAuth, (req, res) => {
  const { channel, externalId } = req.body || {};
  if (!channel || !externalId) return res.status(400).json({ ok: false, error: "channel and externalId required" });
  const ok = revokePairing(channel as PairingChannel, String(externalId));
  res.json({ ok });
});

// --- Channel config endpoints ---
app.get("/api/channels/config", requireAuth, (_req, res) => {
  res.json({ ok: true, channels: getMaskedConfig() });
});

app.post("/api/channels/config", requireAuth, (req, res) => {
  const { telegram, discord, slack } = req.body || {};
  try {
    // Load existing config, merge only non-empty values
    const existing = loadChannelConfig();
    if (telegram?.botToken) existing.telegram = { botToken: telegram.botToken };
    if (discord?.botToken) existing.discord = { botToken: discord.botToken };
    if (slack?.botToken || slack?.signingSecret) {
      existing.slack = {
        botToken: slack.botToken || existing.slack?.botToken || "",
        signingSecret: slack.signingSecret || existing.slack?.signingSecret || "",
      };
    }
    saveChannelConfig(existing);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- Session endpoints ---
app.get("/api/sessions", requireAuth, (req, res) => {
  const userId = req.query.userId as string | undefined;
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Number(req.query.offset) || 0;
  const all = listSessions(userId);
  res.json({ sessions: all.slice(offset, offset + limit), total: all.length });
});

app.get("/api/sessions/search", requireAuth, (req, res) => {
  const q = (req.query.q as string) || "";
  if (!q.trim()) return res.json({ ok: true, hits: [], total: 0 });
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const userId = req.query.userId as string | undefined;
  const hits = searchSessions(q, limit, userId);
  res.json({ ok: true, hits, total: hits.length, query: q });
});

app.get("/api/sessions/:id", requireAuth, (req, res) => {
  const session = loadSession(req.params.id);
  if (!session) return res.status(404).json({ ok: false, error: "session not found" });
  res.json(session);
});

app.post("/api/sessions/:id/thinking", requireAuth, (req, res) => {
  const { level } = req.body || {};
  if (!THINKING_LEVELS.includes(level)) {
    return res.status(400).json({ ok: false, error: `level must be one of: ${THINKING_LEVELS.join(", ")}` });
  }
  const s = setThinkingLevel(req.params.id, level as ThinkingLevel);
  if (!s) return res.status(404).json({ ok: false, error: "session not found" });
  res.json({ ok: true, sessionId: s.id, thinkingLevel: s.thinkingLevel });
});

// --- File Upload endpoints ---
app.post("/api/upload", requireAuth, upload.array("files", 10), (req, res) => {
  const files = req.files as Express.Multer.File[];
  if (!files || files.length === 0) {
    return res.status(400).json({ ok: false, error: "No files uploaded" });
  }
  const attachments = files.map(fileToAttachment);
  res.json({ ok: true, attachments });
});

app.use("/uploads", requireAuth, ...safeStatic(UPLOADS_DIR));

// --- Security Audit endpoints ---
app.get("/api/security/events", requireAuth, (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 500);
  const offset = Number(req.query.offset) || 0;
  const type = req.query.type as "block" | "tool_exec" | undefined;
  const result = auditLogger.getRecentEvents(limit, offset, type);
  res.json({ ok: true, ...result });
});

app.get("/api/security/stats", requireAuth, (_req, res) => {
  res.json({ ok: true, stats: auditLogger.getStats() });
});

app.get("/api/security/patterns", requireAuth, (_req, res) => {
  res.json({ ok: true, patterns: auditLogger.getPatternHitCounts() });
});

app.get("/api/security/export", requireAuth, (_req, res) => {
  res.setHeader("Content-Type", "application/jsonl");
  res.setHeader("Content-Disposition", "attachment; filename=audit.jsonl");
  res.send(auditLogger.exportLog());
});

app.get("/api/security/verify-chain", requireAuth, (_req, res) => {
  res.json({ ok: true, ...auditLogger.verifyChain() });
});

app.get("/api/security/loop-guard", requireAuth, (req, res) => {
  const sessionId = (req.query.sessionId as string) || "default";
  res.json({ ok: true, ...getLoopGuardStats(sessionId) });
});

app.get("/api/security/quotas", requireAuth, (_req, res) => {
  res.json({ ok: true, quotas: getAllQuotas() });
});

app.get("/api/security/tool-history", requireAuth, (req, res) => {
  const hours = Math.min(Math.max(Number(req.query.hours) || 24, 1), 24 * 30);
  res.json({ ok: true, ...auditLogger.getToolHistory(hours) });
});

app.get("/api/heartbeat/triage-log", requireAuth, (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Number(req.query.offset) || 0;
  const jobFilter = req.query.job as string | undefined;
  const statusFilter = req.query.status as string | undefined;
  try {
    const db = getDb();
    const conditions: string[] = [];
    const params: any[] = [];
    if (jobFilter) { conditions.push("job = ?"); params.push(jobFilter); }
    if (statusFilter === "acted") { conditions.push("acted = 1"); }
    else if (statusFilter === "skipped") { conditions.push("acted = 0 AND error IS NULL"); }
    else if (statusFilter === "error") { conditions.push("error IS NOT NULL"); }
    const where = conditions.length ? " WHERE " + conditions.join(" AND ") : "";
    const total = (db.prepare(`SELECT COUNT(*) as cnt FROM heartbeat_triage${where}`).get(...params) as any).cnt;
    const rows = db.prepare(
      `SELECT * FROM heartbeat_triage${where} ORDER BY ts DESC LIMIT ? OFFSET ?`
    ).all(...params, limit, offset) as any[];
    const entries = rows.map(r => ({
      ts: r.ts, job: r.job, mode: r.mode, acted: !!r.acted,
      reason: r.reason, prompt: r.prompt, durationMs: r.duration_ms,
      result: r.result, error: r.error,
    }));
    res.json({ ok: true, entries, total });
  } catch {
    res.json({ ok: true, entries: [], total: 0 });
  }
});

/* ───────── Heartbeat Job CRUD ───────── */

app.get("/api/heartbeat/jobs", requireAuth, (req, res) => {
  const enabledOnly = req.query.enabled === "true";
  res.json({ ok: true, jobs: listJobs(enabledOnly) });
});

app.get("/api/heartbeat/jobs/:name", requireAuth, (req, res) => {
  const job = getJob(req.params.name);
  if (!job) return res.status(404).json({ ok: false, error: "Job not found" });
  res.json({ ok: true, job });
});

app.post("/api/heartbeat/jobs", requireAuth, (req, res) => {
  const { name, cron, prompt, enabled, mode, scanWindowMs } = req.body;
  if (!name || !cron || !prompt) {
    return res.status(400).json({ ok: false, error: "name, cron, and prompt are required" });
  }
  if (getJob(name)) {
    return res.status(409).json({ ok: false, error: `Job "${name}" already exists` });
  }
  try {
    const job = createJob({ name, cron, prompt, enabled, mode, scanWindowMs });
    // Hot-reload: add to running scheduler
    if (job.enabled !== false) {
      if (!heartbeatCtrl) {
        heartbeatCtrl = startHeartbeat([job], skills, () => getProviderKey());
      } else {
        heartbeatCtrl.addJob(job);
      }
    }
    res.status(201).json({ ok: true, job });
  } catch (err: any) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.put("/api/heartbeat/jobs/:name", requireAuth, (req, res) => {
  const { cron, prompt, enabled, mode, scanWindowMs } = req.body;
  const updated = updateJob(req.params.name, { cron, prompt, enabled, mode, scanWindowMs });
  if (!updated) return res.status(404).json({ ok: false, error: "Job not found" });

  // Hot-reload: update the running scheduler
  if (heartbeatCtrl) {
    if (updated.enabled === false) {
      heartbeatCtrl.removeJob(updated.name);
    } else {
      heartbeatCtrl.addJob(updated);
    }
  } else if (updated.enabled !== false) {
    heartbeatCtrl = startHeartbeat([updated], skills, () => getProviderKey());
  }
  res.json({ ok: true, job: updated });
});

app.delete("/api/heartbeat/jobs/:name", requireAuth, (req, res) => {
  const name = req.params.name;
  if (!deleteJob(name)) return res.status(404).json({ ok: false, error: "Job not found" });
  heartbeatCtrl?.removeJob(name);
  res.json({ ok: true });
});

app.post("/api/heartbeat/jobs/:name/trigger", requireAuth, async (req, res) => {
  const name = req.params.name;
  if (!heartbeatCtrl) {
    return res.status(400).json({ ok: false, error: "Heartbeat scheduler not running" });
  }
  try {
    const result = await heartbeatCtrl.triggerJob(name);
    res.json({ ok: true, result: result?.final ?? null });
  } catch (err: any) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post("/api/heartbeat/reload", requireAuth, (_req, res) => {
  if (heartbeatCtrl) {
    heartbeatCtrl.reloadAll();
  } else {
    const jobs = loadHeartbeatConfig();
    if (jobs.length > 0) {
      heartbeatCtrl = startHeartbeat(jobs, skills, () => getProviderKey());
    }
  }
  const jobs = listJobs(true);
  res.json({ ok: true, message: `Reloaded ${jobs.length} enabled job(s)`, jobs });
});

app.post("/api/security/clear", requireAuth, (_req, res) => {
  auditLogger.clearLog();
  res.json({ ok: true });
});

// --- Backup endpoint: triggers scripts/backup.ts, returns output location ---
app.post("/api/backup", requireAuth, async (req, res) => {
  const includeLogs = !!req.body?.includeLogs;
  try {
    const { spawn } = await import("child_process");
    const scriptPath = path.resolve(APP_ROOT, "dist/scripts/backup.js");
    const args = [scriptPath];
    if (includeLogs) args.push("--include-logs");
    const child = spawn(process.execPath, args, { cwd: process.cwd() });
    let out = ""; let err = "";
    child.stdout.on("data", d => { out += d.toString(); });
    child.stderr.on("data", d => { err += d.toString(); });
    child.on("close", (code) => {
      if (code === 0) {
        // Extract the "Location:" line from output
        const locMatch = out.match(/Location:\s*(.+)/);
        res.json({ ok: true, output: out, location: locMatch?.[1]?.trim() ?? null });
      } else {
        res.status(500).json({ ok: false, error: err || out, exitCode: code });
      }
    });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Public key endpoint for skill manifest verification (no auth required for P2P)
app.get("/api/security/public-key", (_req, res) => {
  const pubKey = getPublicKey();
  if (!pubKey) return res.status(404).json({ ok: false, error: "No signing keypair generated yet" });
  res.json({ ok: true, publicKey: pubKey });
});

function dirSizeBytes(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      try {
        if (e.isDirectory()) total += dirSizeBytes(full);
        else if (e.isFile()) total += fs.statSync(full).size;
      } catch {}
    }
  } catch {}
  return total;
}

function lastHeartbeatRun(): { ts: number; job: string; success: boolean } | null {
  try {
    const db = getDb();
    const row = db.prepare(
      "SELECT ts, job, error FROM heartbeat_triage ORDER BY ts DESC LIMIT 1"
    ).get() as any;
    if (!row) return null;
    return { ts: row.ts, job: row.job, success: !row.error };
  } catch { return null; }
}

function loadedProviders(): string[] {
  try {
    const keys = getKeys();
    return Object.keys(keys).filter(k => !!keys[k]);
  } catch { return []; }
}

function buildHealthPayload(authenticated: boolean) {
  const basic = { ok: true, uptime: Math.floor((Date.now() - BOOT_START) / 1000) };
  if (!authenticated) return basic;

  const channelCfg = loadChannelConfig();
  const dbPath = path.join(process.cwd(), "data", "secureclaw.db");
  const dbSize = fs.existsSync(dbPath) ? fs.statSync(dbPath).size : 0;
  const uploadsSize = dirSizeBytes(UPLOADS_DIR);
  const sessionCount = (() => {
    try { return (getDb().prepare("SELECT COUNT(*) as c FROM sessions").get() as any).c; } catch { return 0; }
  })();
  const quotaSummary = (() => {
    try {
      const all = getAllQuotas();
      return { activeUsers: all.length, totalLlmCalls: all.reduce((s, q) => s + q.llmCalls, 0) };
    } catch { return { activeUsers: 0, totalLlmCalls: 0 }; }
  })();

  return {
    ...basic,
    provider: getProviderName(),
    model: getModelConfig()[getProviderName()] ?? "default",
    skills: skills.length,
    providers: {
      configured: loadedProviders(),
      active: getProviderName(),
    },
    channels: {
      websocket: true,
      discord: isDiscordBotRunning(),
      telegram: !!channelCfg.telegram?.botToken,
      slack: !!channelCfg.slack?.botToken,
    },
    heartbeat: {
      jobs: listJobs().length,
      enabled: listJobs(true).length,
      lastRun: lastHeartbeatRun(),
    },
    storage: {
      dbSizeBytes: dbSize,
      uploadsSizeBytes: uploadsSize,
      sessions: sessionCount,
    },
    quota: quotaSummary,
    memory: {
      rss: Math.round(process.memoryUsage().rss / 1024 / 1024),
      heap: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    },
  };
}

app.get('/health', (req, res) => {
  res.json(buildHealthPayload(isAuthenticated(req)));
});

app.get('/api/health', requireAuth, (_req, res) => {
  res.json(buildHealthPayload(true));
});

// Metrics endpoint (admin-only)
app.get('/api/metrics', requireAuth, (_req, res) => {
  res.json({ ok: true, metrics: snapshotMetrics() });
});

// Create HTTP server shared by Express and WebSocket
const server = createServer(app);
let adminServer: ReturnType<typeof createServer> | null = null;
if (ADMIN_PORT) {
  adminServer = createServer(app);
}

// Attach WebSocket control plane
attachWebSocket(server, skills, () => getProviderKey(), API_TOKEN);
if (adminServer) attachWebSocket(adminServer, skills, () => getProviderKey(), API_TOKEN);

// Seed heartbeat jobs from JSON config on first run, then start from SQLite
const seeded = seedFromJson();
const heartbeatJobs = loadHeartbeatConfig();
let heartbeatCtrl: HeartbeatController | null = null;
if (heartbeatJobs.length > 0) {
  heartbeatCtrl = startHeartbeat(heartbeatJobs, skills, () => getProviderKey());
}

// Start Discord gateway bot
startDiscordBot(skills, () => getProviderKey());

// Start WhatsApp (opt-in via env)
if (process.env.WHATSAPP_ENABLED === "1") {
  startWhatsapp(skills, () => getProviderKey()).catch(err =>
    console.warn(`[whatsapp] startup failed: ${err.message}`)
  );
}

// Initialize encrypted skill secrets cache + migrate legacy plaintext if present
migrateLegacySecrets();
initSkillSecrets();

// Migrate channel secrets from plaintext to encrypted vault
const channelMigration = migrateChannelSecrets();

// Ensure Ed25519 signing keypair exists
ensureKeypair();

// Clean expired sessions every hour
setInterval(() => cleanExpiredSessions(), 3_600_000).unref();
setInterval(() => cleanExpiredUploads(), 3_600_000).unref();

server.listen(PORT, HOST, () => {
  const bootMs = Date.now() - BOOT_START;
  const channelCfg = loadChannelConfig();

  const channels: string[] = ["websocket"];
  if (isDiscordBotRunning()) channels.push("discord");
  if (channelCfg.telegram?.botToken) channels.push("telegram");
  if (channelCfg.slack?.botToken) channels.push("slack");
  if (isWhatsappRunning()) channels.push("whatsapp");

  const notes: string[] = [];
  if (seeded > 0) notes.push(`seeded ${seeded} heartbeat job(s) from config`);
  if (channelMigration.migrated > 0) notes.push(`migrated ${channelMigration.migrated} channel secret(s) to vault`);

  console.log(`
  ╔═══════════════════════════════════════════╗
  ║              > wardyn                     ║
  ╚═══════════════════════════════════════════╝

  URL        http://${HOST}:${PORT}
  WebSocket  ws://${HOST}:${PORT}/ws
  Provider   ${getProviderName()}
  Skills     ${skills.length} loaded
  Channels   ${channels.join(", ")}
  Heartbeat  ${heartbeatJobs.length} job(s) (${listJobs(true).length} enabled)
  Boot       ${bootMs}ms
${notes.length ? "\n  " + notes.map(n => "• " + n).join("\n  ") + "\n" : ""}
  Ready.
`);
});

if (adminServer) {
  adminServer.listen(ADMIN_PORT, ADMIN_HOST, () => {
    log.info("admin.listening", { host: ADMIN_HOST, port: ADMIN_PORT });
  });
}

// Graceful shutdown — drain HTTP, stop heartbeat timers, close SQLite
let shuttingDown = false;
function gracefulShutdown(sig: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info("shutdown.start", { signal: sig });
  const timer = setTimeout(() => {
    log.warn("shutdown.force");
    process.exit(1);
  }, 10_000);
  timer.unref();
  try { heartbeatCtrl?.shutdown(); } catch {}
  const servers: Array<{ close: (cb?: (err?: Error) => void) => void }> = [server];
  if (adminServer) servers.push(adminServer);
  let remaining = servers.length;
  const done = () => {
    if (--remaining > 0) return;
    try { closeDb(); } catch {}
    log.info("shutdown.complete");
    clearTimeout(timer);
    process.exit(0);
  };
  for (const s of servers) {
    try { s.close(() => done()); } catch { done(); }
  }
}
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => gracefulShutdown(sig));
}
