import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "http";
import { randomUUID } from "crypto";
import { Message, SkillMeta, OnStream } from "../types.js";
import { runAgentLoop } from "../orchestrator/agentLoop.js";

interface WsIncoming {
  type: "message" | "new_session";
  text?: string;
  userId?: string;
  sessionId?: string;
}

/* ───────── Per-connection rate limiter ───────── */

const WS_RATE_WINDOW_MS = 60_000;
const WS_RATE_MAX = Number(process.env.WS_RATE_LIMIT) || 20; // messages per minute per connection

interface RateState {
  timestamps: number[];
  warned: boolean;
}

function checkWsRate(state: RateState): boolean {
  const now = Date.now();
  state.timestamps = state.timestamps.filter(t => now - t < WS_RATE_WINDOW_MS);
  if (state.timestamps.length >= WS_RATE_MAX) {
    return false;
  }
  state.timestamps.push(now);
  return true;
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
      const token = connUrl.searchParams.get("token");
      if (token !== apiToken) {
        ws.close(4001, "unauthorized");
        return;
      }
    }

    // Use a consistent default session so all channels share history
    let sessionId = connUrl.searchParams.get("sessionId") || "default";
    const userId = "default";

    // Per-connection rate limiter
    const rateState: RateState = { timestamps: [], warned: false };

    ws.on("message", async (raw) => {
      // Rate limit check
      if (!checkWsRate(rateState)) {
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
        sessionId = data.sessionId || "default";
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

      const msg: Message = {
        id: randomUUID(),
        channel: "websocket",
        userId: data.userId ?? userId,
        text: data.text,
        ts: Date.now()
      };

      const onStream: OnStream = (event) => {
        if (ws.readyState === WebSocket.OPEN) {
          sendJson(ws, event);
        }
      };

      try {
        const result = await runAgentLoop(msg, skills, getApiKey(), {
          sessionId,
          onStream
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
