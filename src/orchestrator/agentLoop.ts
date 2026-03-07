import { Message, ToolCall, ToolResult, SkillMeta } from "../types.js";
import { readFileSync, appendFileSync, mkdirSync } from "fs";
import path from "path";
import { callLLM } from "../llm/openai.js";
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
      message: msg.text, toolResults
    }, providerKey);
    const toolCall = llmResponse.tool_call as ToolCall | null;
    if (!toolCall) { log(msg.id, { final: llmResponse.text, toolResults }); return { final: llmResponse.text, toolResults }; }
    const skill = tools.find(t => t.name === toolCall.name);
    if (!skill?.execute) { toolResults.push({ name: toolCall.name, output: '', error: 'Tool not found' }); continue; }
    try { const output = await skill.execute(toolCall.args, msg); toolResults.push({ name: toolCall.name, output }); }
    catch (err: any) { toolResults.push({ name: toolCall.name, output: '', error: err.message }); }
  }
  log(msg.id, { final: 'Stopped: iteration limit reached.', toolResults });
  return { final: 'Stopped: iteration limit reached.', toolResults };
}
