import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "http";
import { randomUUID } from "crypto";
import { Message, SkillMeta, OnStream } from "../types.js";
import { runAgentLoop } from "../orchestrator/agentLoop.js";

interface WsIncoming {
  type: "message";
  text: string;
  userId?: string;
}

export function attachWebSocket(
  server: Server,
  skills: SkillMeta[],
  getApiKey: () => string,
  apiToken?: string
) {
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws, req) => {
    // Auth check via query param or first message
    if (apiToken) {
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      const token = url.searchParams.get("token");
      if (token !== apiToken) {
        ws.close(4001, "unauthorized");
        return;
      }
    }

    ws.on("message", async (raw) => {
      let data: WsIncoming;
      try {
        data = JSON.parse(raw.toString());
      } catch {
        sendJson(ws, { type: "error", error: "invalid JSON" });
        return;
      }

      if (data.type !== "message" || !data.text) {
        sendJson(ws, { type: "error", error: "expected { type: 'message', text: '...' }" });
        return;
      }

      const msg: Message = {
        id: randomUUID(),
        channel: "websocket",
        userId: data.userId ?? "ws-user",
        text: data.text,
        ts: Date.now()
      };

      const onStream: OnStream = (event) => {
        if (ws.readyState === WebSocket.OPEN) {
          sendJson(ws, event);
        }
      };

      try {
        const result = await runAgentLoop(msg, skills, getApiKey(), onStream);
        sendJson(ws, { type: "final", text: result.final });
      } catch (err: any) {
        sendJson(ws, { type: "error", error: err.message });
      }
    });

    sendJson(ws, { type: "connected", id: randomUUID() });
  });

  return wss;
}

function sendJson(ws: WebSocket, data: any) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}
