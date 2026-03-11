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
import { sendSlackReply, extractSlackChannelId, isSlackBotMessage, isSlackUrlVerification, isSlackMessageEvent, getSlackSigningSecret, verifySlackSignature } from "./channels/slack.js";
import { loadChannelConfig, saveChannelConfig, getMaskedConfig, clearChannelConfigCache } from "./channels/channelConfig.js";
import { attachWebSocket } from "./channels/websocket.js";
import { loadHeartbeatConfig, startHeartbeat } from "./orchestrator/heartbeat.js";
import { listSessions, loadSession, cleanExpiredSessions } from "./orchestrator/sessionStore.js";
import { getProviderName, setProviderName } from "./llm/router.js";
import { buildSkill } from "./builder/builderAgent.js";
import { deleteSkill, isProtected } from "./builder/skillWriter.js";
import { auditLogger } from "./security/auditLog.js";
import { exportSkill, importSkill, importFromUrl, listPackages, getPackage, deletePackage } from "./hub/hubManager.js";
import { getMaskedSecrets, setSkillSecret, deleteSkillSecret, initSkillSecrets, migrateLegacySecrets } from "./security/skillSecrets.js";
import { createServer } from "http";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(bodyParser.json({
  limit: "1mb",
  verify: (req: any, _res, buf) => { req.rawBody = buf.toString(); },
}));
const skills = loadSkills();

function reloadSkills() {
  const fresh = loadSkills();
  skills.length = 0;
  skills.push(...fresh);
}
const PORT = Number(process.env.PORT) || 3000;
const HOST = "127.0.0.1";
const API_TOKEN = process.env.API_TOKEN;

// cache decrypted keys to avoid per-request decrypt
let cachedKeys: Record<string, string> | null = null;
function getKeys(): Record<string, string> {
  if (cachedKeys) return cachedKeys;
  cachedKeys = loadKeys(process.env.KEY_PASSPHRASE ?? "");
  return cachedKeys;
}

function getProviderKey(): string {
  const provider = getProviderName();
  const keys = getKeys();
  // Ollama doesn't need a key
  if (provider === "ollama") return "ollama-local";
  return keys[provider] ?? keys["openai"] ?? "";
}

function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!API_TOKEN) return next(); // optional
  const token = req.get("x-api-token");
  if (token === API_TOKEN) return next();
  return res.status(401).json({ ok: false, error: "unauthorized" });
}

// Simple in-memory rate limiter
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = Number(process.env.RATE_LIMIT) || 30;
const hits = new Map<string, number[]>();

function rateLimit(req: express.Request, res: express.Response, next: express.NextFunction) {
  const ip = req.ip ?? "unknown";
  const now = Date.now();
  const timestamps = (hits.get(ip) ?? []).filter(t => now - t < RATE_WINDOW_MS);
  if (timestamps.length >= RATE_MAX) {
    return res.status(429).json({ ok: false, error: "rate limit exceeded" });
  }
  timestamps.push(now);
  hits.set(ip, timestamps);
  return next();
}

// Clean up stale entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, timestamps] of hits) {
    const active = timestamps.filter(t => now - t < RATE_WINDOW_MS);
    if (active.length === 0) hits.delete(ip);
    else hits.set(ip, active);
  }
}, 300_000).unref();

// Serve static UI
app.use("/ui", express.static(path.join(process.cwd(), "public")));
app.get("/chat", (_req, res) => res.sendFile(path.join(process.cwd(), "public", "chat.html")));

// Serve skill output files (images, downloads, etc.)
app.use("/output", express.static(path.join(process.cwd(), "output")));
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
    cachedKeys = null;
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
    cachedKeys = null; // refresh key cache for new provider
    res.json({ ok: true, provider: getProviderName() });
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

// --- ClawHub endpoints ---
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
  const smokeTest = req.query.smokeTest === "true";
  try {
    const result = await importSkill(req.body, smokeTest);
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
    const msg = normalizeTelegram(req.body);
    const key = getProviderKey();
    const result = await runAgentLoop(msg, skills, key, {
      sessionId: "default"
    });
    if (result.final) {
      const chatId = extractChatId(req.body);
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
    const msg = normalizeDiscord(req.body);
    const key = getProviderKey();
    const result = await runAgentLoop(msg, skills, key, {
      sessionId: "default"
    });
    if (result.final) {
      const channelId = extractChannelId(req.body);
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

  // Verify signature if signing secret is configured
  const signingSecret = getSlackSigningSecret();
  if (signingSecret) {
    const timestamp = req.get("x-slack-request-timestamp") ?? "";
    const signature = req.get("x-slack-signature") ?? "";
    const rawBody = (req as any).rawBody ?? "";
    if (!verifySlackSignature(signingSecret, timestamp, rawBody, signature)) {
      return res.status(401).json({ ok: false, error: "invalid signature" });
    }
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
    const msg = normalizeSlack(req.body);
    const key = getProviderKey();
    const result = await runAgentLoop(msg, skills, key, {
      sessionId: "default"
    });
    if (result.final) {
      const channelId = extractSlackChannelId(req.body);
      if (channelId) await sendSlackReply(channelId, result.final);
    }
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
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
app.get("/api/sessions", requireAuth, (_req, res) => {
  const userId = _req.query.userId as string | undefined;
  res.json({ sessions: listSessions(userId) });
});

app.get("/api/sessions/:id", requireAuth, (req, res) => {
  const session = loadSession(req.params.id);
  if (!session) return res.status(404).json({ ok: false, error: "session not found" });
  res.json(session);
});

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

app.post("/api/security/clear", requireAuth, (_req, res) => {
  auditLogger.clearLog();
  res.json({ ok: true });
});

app.get('/health', (_req, res) => res.json({ ok: true, provider: getProviderName(), discord: isDiscordBotRunning() }));

// Create HTTP server shared by Express and WebSocket
const server = createServer(app);

// Attach WebSocket control plane
attachWebSocket(server, skills, () => getProviderKey(), API_TOKEN);

// Start heartbeat scheduler
const heartbeatJobs = loadHeartbeatConfig();
if (heartbeatJobs.length > 0) {
  startHeartbeat(heartbeatJobs, skills, () => getProviderKey());
}

// Start Discord gateway bot
startDiscordBot(skills, () => getProviderKey());

// Initialize encrypted skill secrets cache + migrate legacy plaintext if present
migrateLegacySecrets();
initSkillSecrets();

// Clean expired sessions every hour
setInterval(() => cleanExpiredSessions(), 3_600_000).unref();

server.listen(PORT, HOST, () => {
  console.log(`Secure-Claw Gateway listening on http://${HOST}:${PORT}`);
  console.log(`LLM provider: ${getProviderName()}`);
  console.log(`WebSocket available at ws://${HOST}:${PORT}/ws`);
  if (heartbeatJobs.length > 0) {
    console.log(`Heartbeat: ${heartbeatJobs.length} job(s) scheduled`);
  }
});
