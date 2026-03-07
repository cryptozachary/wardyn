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
import { createServer } from "http";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(bodyParser.json({ limit: "1mb" }));
const skills = loadSkills();
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
  const { passphrase, openaiKey } = req.body || {};
  if (!passphrase || !openaiKey) {
    return res.status(400).json({ ok: false, error: "passphrase and openaiKey required" });
  }
  try {
    storeKey("openai", openaiKey, passphrase);
    cachedKeys = null;
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
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
app.post('/webhook/telegram', rateLimit, requireAuth, async (req, res) => {
  try {
    const msg = normalizeTelegram(req.body);
    const key = getKeys()['openai'];
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
    const key = getKeys()['openai'];
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

app.get('/health', (_req, res) => res.json({ ok: true }));

// Create HTTP server shared by Express and WebSocket
const server = createServer(app);

// Attach WebSocket control plane
attachWebSocket(server, skills, () => getKeys()["openai"], API_TOKEN);

// Start heartbeat scheduler
const heartbeatJobs = loadHeartbeatConfig();
if (heartbeatJobs.length > 0) {
  startHeartbeat(heartbeatJobs, skills, () => getKeys()["openai"]);
}

// Clean expired sessions every hour
setInterval(() => cleanExpiredSessions(), 3_600_000).unref();

server.listen(PORT, HOST, () => {
  console.log(`Secure-Claw Gateway listening on http://${HOST}:${PORT}`);
  console.log(`WebSocket available at ws://${HOST}:${PORT}/ws`);
  if (heartbeatJobs.length > 0) {
    console.log(`Heartbeat: ${heartbeatJobs.length} job(s) scheduled`);
  }
});
