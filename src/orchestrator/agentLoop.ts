import { Message, ToolCall, ToolResult, SkillMeta } from "../types.js";
import { readFileSync, appendFileSync, mkdirSync } from "fs";
import path from "path";
import { callLLM } from "../llm/openai.js";
import { assertSafe } from "../security/safetySpine.js";
function loadContext() {
  const memory = readFileSync(path.join(process.cwd(), "memory", "MEMORY.md"), "utf8");
  const soul = readFileSync(path.join(process.cwd(), "memory", "SOUL.md"), "utf8");
  return { memory, soul };
}
function log(sessionId: string, data: any) {
  const logDir = path.join(process.cwd(), "logs"); mkdirSync(logDir, { recursive: true });
  appendFileSync(path.join(logDir, `${sessionId}.log`), JSON.stringify(data) + "\n");
}
export async function runAgentLoop(msg: Message, tools: SkillMeta[], providerKey: string) {
  const ctx = loadContext(); let toolResults: ToolResult[] = []; let iterations = 0;
  while (iterations++ < 8) {
    const llmResponse = await callLLM({
      system: `${ctx.soul}\n\n${ctx.memory}\n\nAvailable tools:\n${tools.map(t => `- ${t.name}`).join("\n")}`,
      message: msg.text,
      toolResults,
      tools: tools.map(t => ({ name: t.name, description: t.description }))
    }, providerKey);
    const toolCalls = (llmResponse.tool_calls as ToolCall[]) || [];
    if (!toolCalls.length) { log(msg.id, { final: llmResponse.text, toolResults }); return { final: llmResponse.text, toolResults }; }
    for (const tc of toolCalls) {
      const skill = tools.find(t => t.name === tc.name);
      if (!skill?.execute) { toolResults.push({ name: tc.name, output: '', error: 'Tool not found' }); continue; }
      try {
        validateArgs(tc.args);
        const output = await skill.execute(tc.args, msg);
        toolResults.push({ name: tc.name, output });
      }
      catch (err: any) { toolResults.push({ name: tc.name, output: '', error: err.message }); }
    }
  }
  log(msg.id, { final: 'Stopped: iteration limit reached.', toolResults });
  return { final: 'Stopped: iteration limit reached.', toolResults };
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
