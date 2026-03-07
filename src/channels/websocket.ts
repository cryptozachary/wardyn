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

export function attachWebSocket(
  server: Server,
  skills: SkillMeta[],
  getApiKey: () => string,
  apiToken?: string
) {
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws, req) => {
    if (apiToken) {
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      const token = url.searchParams.get("token");
      if (token !== apiToken) {
        ws.close(4001, "unauthorized");
        return;
      }
    }

    // Default session per connection
    let sessionId = `ws-${randomUUID()}`;
    const userId = "ws-user";

    ws.on("message", async (raw) => {
      let data: WsIncoming;
      try {
        data = JSON.parse(raw.toString());
      } catch {
        sendJson(ws, { type: "error", error: "invalid JSON" });
        return;
      }

      // Allow client to start a new session
      if (data.type === "new_session") {
        sessionId = `ws-${randomUUID()}`;
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
