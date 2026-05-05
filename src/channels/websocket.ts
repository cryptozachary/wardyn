import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "http";
import { randomUUID, createHmac, timingSafeEqual } from "crypto";
import { Message, Attachment, SkillMeta, OnStream } from "../types.js";
import { runAgentLoop } from "../orchestrator/agentLoop.js";
import { getAttachmentById } from "../uploads/uploadHandler.js";
import { checkRateLimit } from "../security/rateLimit.js";

interface WsIncoming {
  type: "message" | "new_session";
  text?: string;
  userId?: string;
  sessionId?: string;
  attachmentIds?: string[];
}

/* ───────── Durable rate limiter (SQLite-backed) ───────── */

const WS_RATE_WINDOW_MS = 60_000;
const WS_RATE_MAX = Number(process.env.WS_RATE_LIMIT) || 20; // messages per minute per key

interface RateState { warned: boolean }

function checkWsRate(key: string): boolean {
  return checkRateLimit("ws", key, WS_RATE_WINDOW_MS, WS_RATE_MAX);
}

function safeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a); const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

/**
 * Cookie-auth WebSocket connections need an explicit Origin allowlist —
 * cookies are auto-attached cross-site and SameSite=Strict does not apply
 * to WebSockets, so without this check a malicious page can hijack a
 * logged-in admin's session (CSWSH).
 *
 * Token-auth (header / query) connections skip this since the caller had
 * to know the secret to attach it.
 */
function buildAllowedOrigins(): Set<string> {
  const allowed = new Set<string>();
  const explicit = (process.env.WARDYN_ALLOWED_ORIGINS || "")
    .split(",").map(s => s.trim()).filter(Boolean);
  for (const o of explicit) allowed.add(o.toLowerCase());

  const host = process.env.HOST || "127.0.0.1";
  const port = process.env.PORT || "3000";
  const adminPort = process.env.ADMIN_PORT;
  const hosts = new Set([host, "127.0.0.1", "localhost"]);
  for (const h of hosts) {
    allowed.add(`http://${h}:${port}`);
    allowed.add(`https://${h}:${port}`);
    if (adminPort) {
      allowed.add(`http://${h}:${adminPort}`);
      allowed.add(`https://${h}:${adminPort}`);
    }
  }
  return allowed;
}
const ALLOWED_ORIGINS = buildAllowedOrigins();

function isOriginAllowed(origin: string | undefined): boolean {
  // Electron BrowserWindow loading from disk sends `file://`. The desktop
  // app authenticates via cookie injected post-login, so it lands on this
  // path; allow it explicitly.
  if (!origin) return false;
  const o = origin.toLowerCase();
  if (o === "null" || o.startsWith("file://")) return true;
  return ALLOWED_ORIGINS.has(o);
}

function validateCookieSession(cookieHeader: string | undefined): boolean {
  const secret = process.env.COOKIE_SECRET || process.env.API_TOKEN;
  if (!secret) return false;
  const cookies = parseCookies(cookieHeader);
  const token = cookies["wardyn_auth"];
  if (!token) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [expStr, nonce, sig] = parts;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  const expected = createHmac("sha256", secret).update(`${expStr}.${nonce}`).digest("hex");
  return safeEq(expected, sig);
}

/* ───────── WebSocket server ───────── */

export function attachWebSocket(
  server: Server,
  skills: SkillMeta[],
  getApiKey: () => string,
  apiToken?: string
) {
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws, req) => {
    const connUrl = new URL(req.url ?? "/", `http://${req.headers.host}`);

    if (apiToken) {
      const qToken = connUrl.searchParams.get("token");
      const headerToken = (req.headers["x-api-token"] as string | undefined) || "";
      const cookieOk = validateCookieSession(req.headers.cookie);
      const headerOk = !!headerToken && safeEq(headerToken, apiToken);
      const queryOk = !!qToken && safeEq(qToken, apiToken);
      if (!cookieOk && !headerOk && !queryOk) {
        ws.close(4001, "unauthorized");
        return;
      }
      // Cookie-only auth must come from an allowlisted origin to defeat
      // cross-site WebSocket hijacking (CSWSH). Header/query token auth
      // is exempt because the caller already proved knowledge of a secret.
      if (cookieOk && !headerOk && !queryOk) {
        const origin = req.headers.origin as string | undefined;
        if (!isOriginAllowed(origin)) {
          ws.close(4003, "origin not allowed");
          return;
        }
      }
    } else if (process.env.NODE_ENV === "production") {
      ws.close(4001, "unauthorized");
      return;
    }

    // Use a consistent default session so all channels share history
    let sessionId = connUrl.searchParams.get("sessionId") || "default";
    const userId = "default";

    // Shared/durable rate limiter (SQLite-backed, per-IP key)
    const rateKey = (req.socket.remoteAddress || "unknown") + ":" + (req.headers["x-forwarded-for"] || "");
    const rateState: RateState = { warned: false };

    // Per-connection abort controller — fires on socket close so any
    // in-flight agent loop spawned by this client stops promptly.
    const connAbort = new AbortController();
    ws.on("close", () => connAbort.abort(new Error("websocket closed")));

    ws.on("message", async (raw) => {
      // Rate limit check
      if (!checkWsRate(rateKey)) {
        if (!rateState.warned) {
          sendJson(ws, { type: "error", error: "Rate limit exceeded. Max " + WS_RATE_MAX + " messages/minute." });
          rateState.warned = true;
          // Reset warning flag after window passes
          setTimeout(() => { rateState.warned = false; }, WS_RATE_WINDOW_MS);
        }
        return;
      }

      let data: WsIncoming;
      try {
        data = JSON.parse(raw.toString());
      } catch {
        sendJson(ws, { type: "error", error: "invalid JSON" });
        return;
      }

      // Allow client to start a fresh session (clears shared history)
      if (data.type === "new_session") {
        sessionId = randomUUID();
        sendJson(ws, { type: "session", sessionId });
        return;
      }

      if (data.type !== "message" || !data.text) {
        sendJson(ws, { type: "error", error: "expected { type: 'message', text: '...' }" });
        return;
      }

      // Allow client to specify or resume a session
      if (data.sessionId) {
        sessionId = data.sessionId;
      }

      // Resolve attachment references from prior upload
      let attachments: Attachment[] | undefined;
      if (data.attachmentIds?.length) {
        attachments = data.attachmentIds
          .map(id => getAttachmentById(id))
          .filter((a): a is Attachment => a !== null);
      }

      const msg: Message = {
        id: randomUUID(),
        channel: "websocket",
        userId: data.userId ?? userId,
        text: data.text,
        ts: Date.now(),
        ...(attachments?.length ? { attachments } : {}),
      };

      const onStream: OnStream = (event) => {
        if (ws.readyState === WebSocket.OPEN) {
          sendJson(ws, event);
        }
      };

      try {
        const result = await runAgentLoop(msg, skills, getApiKey(), {
          sessionId,
          onStream,
          signal: connAbort.signal,
        });
        sendJson(ws, { type: "final", text: result.final, sessionId: result.sessionId });
      } catch (err: any) {
        sendJson(ws, { type: "error", error: err.message });
      }
    });

    sendJson(ws, { type: "connected", id: randomUUID(), sessionId });
  });

  return wss;
}

function sendJson(ws: WebSocket, data: any) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}
