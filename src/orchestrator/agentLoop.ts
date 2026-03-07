import { Message, ToolCall, ToolResult, SkillMeta } from "../types.js";
import { readFileSync, appendFileSync, mkdirSync, existsSync } from "fs";
import path from "path";
import { callLLM } from "../llm/openai.js";
import { assertSafe } from "../security/safetySpine.js";

function loadContext() {
  const memPath = path.join(process.cwd(), "memory", "MEMORY.md");
  const soulPath = path.join(process.cwd(), "memory", "SOUL.md");
  const memory = existsSync(memPath) ? readFileSync(memPath, "utf8") : "";
  const soul = existsSync(soulPath) ? readFileSync(soulPath, "utf8") : "";
  return { memory, soul };
}

function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

function log(sessionId: string, data: any) {
  const logDir = path.join(process.cwd(), "logs"); mkdirSync(logDir, { recursive: true });
  appendFileSync(path.join(logDir, `${sanitizeId(sessionId)}.log`), JSON.stringify(data) + "\n");
}

export async function runAgentLoop(msg: Message, tools: SkillMeta[], providerKey: string) {
  const ctx = loadContext();
  const toolDefs = tools.map(t => ({ name: t.name, description: t.description }));
  const toolList = tools.map(t => `- ${t.name}: ${t.description}`).join("\n");
  const systemPrompt = `${ctx.soul}\n\n${ctx.memory}\n\nAvailable tools:\n${toolList}`;

  const messages: any[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: msg.text }
  ];

  let toolResults: ToolResult[] = [];
  let iterations = 0;

  while (iterations++ < 8) {
    const llmResponse = await callLLM({ messages, tools: toolDefs }, providerKey);

    if (!llmResponse.tool_calls) {
      log(msg.id, { final: llmResponse.text, toolResults });
      return { final: llmResponse.text, toolResults };
    }

    // Append the assistant message with tool_calls
    messages.push({
      role: "assistant",
      content: null,
      tool_calls: llmResponse.tool_calls
    });

    // Execute each tool call and append tool results as proper messages
    for (const tc of llmResponse.tool_calls) {
      const parsed: ToolCall = {
        name: tc.function.name,
        args: JSON.parse(tc.function.arguments || "{}")
      };
      const skill = tools.find(t => t.name === parsed.name);

      let output = "";
      let error: string | undefined;

      if (!skill?.execute) {
        error = "Tool not found";
      } else {
        try {
          validateArgs(parsed.args);
          output = await skill.execute(parsed.args, msg);
        } catch (err: any) {
          error = err.message;
        }
      }

      toolResults.push({ name: parsed.name, output, error });

      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: error ? `Error: ${error}` : output
      });
    }
  }

  log(msg.id, { final: "Stopped: iteration limit reached.", toolResults });
  return { final: "Stopped: iteration limit reached.", toolResults };
}

function validateArgs(args: any) {
  if (!args || typeof args !== "object") return;
  const scan = (val: any) => {
    if (Array.isArray(val)) return val.forEach(scan);
    if (val && typeof val === "object") {
      for (const [k, v] of Object.entries(val)) {
        if (typeof v === "string" && /(command|cmd|script)/i.test(k)) {
          assertSafe(v);
        }
        scan(v);
      }
    }
  };
  scan(args);
}
