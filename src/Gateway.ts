import express from "express";
import bodyParser from "body-parser";
import path from "path";
import fs from "fs";
import { loadSkills } from "./skills/loader.js";
import { runAgentLoop } from "./orchestrator/agentLoop.js";
import { Message } from "./types.js";
import { loadKeys, storeKey } from "./security/keyVault.js";
import { sendTelegramReply, extractChatId } from "./channels/telegram.js";
import { sendDiscordReply, extractChannelId } from "./channels/discord.js";
import { attachWebSocket } from "./channels/websocket.js";
import { loadHeartbeatConfig, startHeartbeat } from "./orchestrator/heartbeat.js";
import { listSessions, loadSession, cleanExpiredSessions } from "./orchestrator/sessionStore.js";
import { getProviderName, setProviderName } from "./llm/router.js";
import { buildSkill } from "./builder/builderAgent.js";
import { deleteSkill, isProtected } from "./builder/skillWriter.js";
import { createServer } from "http";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(bodyParser.json({ limit: "1mb" }));
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
function normalizeTelegram(body: any): Message {
  return { id: String(body.update_id ?? Date.now()), channel: "telegram", userId: String(body.message?.from?.id ?? "unknown"), text: body.message?.text ?? "", ts: Date.now() };
}
function normalizeDiscord(body: any): Message {
  return { id: body.id ?? String(Date.now()), channel: "discord", userId: body.author?.id ?? "unknown", text: body.content ?? "", ts: Date.now() };
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
    })),
  });
});

app.post("/api/skills/build", rateLimit, requireAuth, async (req, res) => {
  const { prompt, language, overwrite } = req.body || {};
  if (!prompt || typeof prompt !== "string") {
    return res.status(400).json({ ok: false, error: "prompt is required" });
  }
  try {
    const apiKey = getProviderKey();
    const result = await buildSkill({ prompt, language }, apiKey, overwrite === true);

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

app.post('/webhook/telegram', rateLimit, requireAuth, async (req, res) => {
  try {
    const msg = normalizeTelegram(req.body);
    const key = getProviderKey();
    const result = await runAgentLoop(msg, skills, key, {
      sessionId: `telegram-${msg.userId}`
    });
    if (result.final && process.env.TELEGRAM_BOT_TOKEN) {
      const chatId = extractChatId(req.body);
      if (chatId) await sendTelegramReply(chatId, result.final);
    }
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});
app.post('/webhook/discord', rateLimit, requireAuth, async (req, res) => {
  try {
    const msg = normalizeDiscord(req.body);
    const key = getProviderKey();
    const result = await runAgentLoop(msg, skills, key, {
      sessionId: `discord-${msg.userId}`
    });
    if (result.final && process.env.DISCORD_BOT_TOKEN) {
      const channelId = extractChannelId(req.body);
      if (channelId) await sendDiscordReply(channelId, result.final);
    }
    res.json(result);
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

app.get('/health', (_req, res) => res.json({ ok: true, provider: getProviderName() }));

// Create HTTP server shared by Express and WebSocket
const server = createServer(app);

// Attach WebSocket control plane
attachWebSocket(server, skills, () => getProviderKey(), API_TOKEN);

// Start heartbeat scheduler
const heartbeatJobs = loadHeartbeatConfig();
if (heartbeatJobs.length > 0) {
  startHeartbeat(heartbeatJobs, skills, () => getProviderKey());
}

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
