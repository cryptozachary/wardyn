import {
  listSessions,
  loadSession,
  saveSession,
  appendToSession,
  getOrCreateSession,
} from "../../src/orchestrator/sessionStore.js";

export const parameters = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["list", "history", "send"],
      description: "list=enumerate sessions; history=fetch messages of a session; send=append a note into another session",
    },
    session: { type: "string", description: "for history/send: target session id" },
    limit: { type: "number", description: "for list/history: max items (default 20 / 30)" },
    text: { type: "string", description: "for send: the message body" },
    from: { type: "string", description: "for send: who is posting (shown in the target session, default=the caller sessionId)" },
    role: {
      type: "string",
      enum: ["system", "assistant"],
      description: "for send: role of the injected message (default system)",
    },
  },
  required: ["action"],
};

function callerSessionId(args: any): string {
  return (args._sessionId as string) || "default";
}

export async function execute(args: any): Promise<string> {
  const { action } = args;

  try {
    switch (action) {
      case "list": {
        const limit = Math.max(1, Math.min(Number(args.limit) || 20, 200));
        const ids = listSessions().slice(0, limit);
        const sessions = ids.map(id => {
          const s = loadSession(id);
          if (!s) return { id };
          return {
            id: s.id,
            userId: s.userId,
            updatedAt: s.updatedAt,
            messageCount: s.messages.length,
            strategistMode: s.strategistMode,
            thinkingLevel: s.thinkingLevel,
            summary: s.summary ? s.summary.slice(0, 140) : "",
          };
        });
        return JSON.stringify({ status: "ok", action: "list", count: sessions.length, sessions });
      }

      case "history": {
        const session = args.session as string;
        if (!session) throw new Error("session is required for history");
        const s = loadSession(session);
        if (!s) throw new Error(`session not found: ${session}`);
        const limit = Math.max(1, Math.min(Number(args.limit) || 30, 200));
        const messages = s.messages.slice(-limit).map(m => ({
          role: m.role,
          ts: m.ts,
          content: typeof m.content === "string" ? m.content.slice(0, 1000) : null,
        }));
        return JSON.stringify({
          status: "ok",
          action: "history",
          session: s.id,
          summary: s.summary,
          messageCount: s.messages.length,
          messages,
        });
      }

      case "send": {
        const target = args.session as string;
        const text = args.text as string;
        if (!target) throw new Error("session is required for send");
        if (!text || typeof text !== "string") throw new Error("text is required for send");

        const caller = callerSessionId(args);
        if (target === caller) throw new Error("refusing to send to caller session");

        const from = (args.from as string) || caller;
        const role = (args.role === "assistant" ? "assistant" : "system") as "system" | "assistant";

        const s = getOrCreateSession(target, "bridge");
        const body = `[bridge from ${from}] ${text}`;
        appendToSession(s, { role, content: body, ts: Date.now() });
        saveSession(s);

        return JSON.stringify({
          status: "ok",
          action: "send",
          from,
          to: target,
          role,
          chars: body.length,
        });
      }

      default:
        throw new Error(`unknown action: ${action}`);
    }
  } catch (err: any) {
    return JSON.stringify({ status: "error", action, error: err.message });
  }
}
