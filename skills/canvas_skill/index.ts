import { pushCanvas, listCanvas, clearCanvas, getCanvas } from "../../src/orchestrator/canvasStore.js";

export const parameters = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["push", "list", "get", "clear"],
      description: "push=add an item to the canvas, list=show recent items, get=fetch one by id, clear=delete items",
    },
    kind: {
      type: "string",
      enum: ["markdown", "table", "chart", "html", "code", "json"],
      description: "for push: content kind. markdown=GFM string; table={columns,rows}; chart={type,labels,series}; html=sanitized HTML; code={language,source}; json=any object.",
    },
    title: { type: "string", description: "optional title shown above the item" },
    data: {
      description: "for push: the payload. See kind for shape. markdown=string, table={columns:string[],rows:string[][]}, chart={type:'bar'|'line',labels:string[],series:{name,values:number[]}[]}, code={language,source}, html=string, json=any.",
    },
    id: { type: "string", description: "for get: item id" },
    session: { type: "string", description: "override session id (defaults to caller session)" },
    scope: { type: "string", enum: ["session", "all"], description: "for list/clear: limit to caller session (default) or all sessions" },
    limit: { type: "number", description: "for list: max items (default 50)" },
  },
  required: ["action"],
};

function callerSession(args: any): string {
  return (args._sessionId as string) || "default";
}

export async function execute(args: any): Promise<string> {
  const { action } = args;

  try {
    switch (action) {
      case "push": {
        const { kind, data, title } = args;
        if (!kind) throw new Error("kind is required for push");
        if (data === undefined || data === null) throw new Error("data is required for push");

        validatePayload(kind, data);

        const session = (args.session as string) || callerSession(args);
        const item = pushCanvas(session, kind, data, title);
        return JSON.stringify({
          status: "ok",
          action: "push",
          id: item.id,
          kind: item.kind,
          session: item.sessionId,
          url: `/ui/canvas.html?session=${encodeURIComponent(item.sessionId)}`,
        });
      }

      case "list": {
        const scope = args.scope ?? "session";
        const session = scope === "all" ? undefined : ((args.session as string) || callerSession(args));
        const limit = Math.max(1, Math.min(Number(args.limit) || 50, 500));
        const items = listCanvas(session, limit).map(i => ({
          id: i.id, kind: i.kind, title: i.title, session: i.sessionId, createdAt: i.createdAt,
        }));
        return JSON.stringify({ status: "ok", action: "list", scope, count: items.length, items });
      }

      case "get": {
        if (!args.id) throw new Error("id is required for get");
        const item = getCanvas(args.id);
        if (!item) throw new Error(`no canvas item with id ${args.id}`);
        return JSON.stringify({ status: "ok", action: "get", item });
      }

      case "clear": {
        const scope = args.scope ?? "session";
        const session = scope === "all" ? undefined : ((args.session as string) || callerSession(args));
        const deleted = clearCanvas(session);
        return JSON.stringify({ status: "ok", action: "clear", scope, deleted });
      }

      default:
        throw new Error(`unknown action: ${action}`);
    }
  } catch (err: any) {
    return JSON.stringify({ status: "error", action, error: err.message });
  }
}

function validatePayload(kind: string, data: any): void {
  switch (kind) {
    case "markdown":
    case "html":
      if (typeof data !== "string") throw new Error(`${kind} payload must be a string`);
      break;
    case "code":
      if (!data?.source || typeof data.source !== "string") throw new Error("code payload needs { source, language? }");
      break;
    case "table":
      if (!Array.isArray(data?.columns) || !Array.isArray(data?.rows)) throw new Error("table payload needs { columns: string[], rows: any[][] }");
      break;
    case "chart":
      if (!data?.labels || !Array.isArray(data.labels) || !Array.isArray(data?.series)) {
        throw new Error("chart payload needs { type, labels: string[], series: [{ name, values: number[] }] }");
      }
      break;
    case "json":
      // anything JSON-serializable is fine
      JSON.stringify(data);
      break;
  }
}
