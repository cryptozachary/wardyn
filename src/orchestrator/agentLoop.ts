import { Message, ToolCall, ToolResult, SkillMeta, OnStream } from "../types.js";
import { readFileSync, appendFileSync, mkdirSync, existsSync } from "fs";
import path from "path";
import { callLLM } from "../llm/router.js";
import { checkSafe } from "../security/safetySpine.js";
import { auditLogger } from "../security/auditLog.js";
import { checkLoop } from "../security/loopGuard.js";
import { checkLLMQuota, checkSkillQuota } from "../security/quotaTracker.js";
import {
  Session, SessionMessage,
  getOrCreateSession, appendToSession, compactIfNeeded, saveSession
} from "./sessionStore.js";

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

export interface AgentLoopOptions {
  sessionId?: string;
  onStream?: OnStream;
}

export async function runAgentLoop(
  msg: Message,
  tools: SkillMeta[],
  providerKey: string,
  onStreamOrOpts?: OnStream | AgentLoopOptions
) {
  // Support both old signature (onStream callback) and new options object
  let sessionId: string | undefined;
  let onStream: OnStream | undefined;

  if (typeof onStreamOrOpts === "function") {
    onStream = onStreamOrOpts;
  } else if (onStreamOrOpts) {
    sessionId = onStreamOrOpts.sessionId;
    onStream = onStreamOrOpts.onStream;
  }

  const ctx = loadContext();
  const toolDefs = tools.map(t => ({ name: t.name, description: t.description, parameters: t.parameters }));
  const toolList = tools.map(t => `- ${t.name}: ${t.description}`).join("\n");
  const systemPrompt = `${ctx.soul}\n\n${ctx.memory}\n\nAvailable tools:\n${toolList}`;

  // Load or create session — unified across all channels (single-user agent)
  const sid = sessionId ?? "default";
  const session = getOrCreateSession(sid, msg.userId);

  // Compact history if it's getting long
  await compactIfNeeded(session, providerKey);

  // Build messages: system + summary context + session history + new user message
  const messages: any[] = [{ role: "system", content: systemPrompt }];

  if (session.summary) {
    messages.push({
      role: "system",
      content: `Conversation summary so far:\n${session.summary}`
    });
  }

  // Replay session history (only user/assistant messages, skip tool details for token efficiency)
  for (const m of session.messages) {
    if (m.role === "user" || m.role === "assistant") {
      messages.push({ role: m.role, content: m.content });
    }
  }

  // Add the new user message
  messages.push({ role: "user", content: msg.text });

  // Track in session
  appendToSession(session, { role: "user", content: msg.text, ts: Date.now() });

  let toolResults: ToolResult[] = [];
  let iterations = 0;

  while (iterations++ < 12) {
    // Per-user LLM quota check
    const quota = checkLLMQuota(msg.userId);
    if (!quota.allowed) {
      const mins = Math.ceil(quota.resetInMs / 60_000);
      const finalText = `Rate limit reached. You have used all ${100} LLM calls this hour. Resets in ~${mins} minutes.`;
      appendToSession(session, { role: "assistant", content: finalText, ts: Date.now() });
      saveSession(session);
      return { final: finalText, toolResults, sessionId: sid };
    }

    onStream?.({ type: "thinking", iteration: iterations });

    const llmResponse = await callLLM({ messages, tools: toolDefs }, providerKey);

    if (!llmResponse.tool_calls) {
      log(msg.id, { final: llmResponse.text, toolResults });

      // Save assistant reply to session
      appendToSession(session, { role: "assistant", content: llmResponse.text, ts: Date.now() });
      saveSession(session);

      return { final: llmResponse.text, toolResults, sessionId: sid };
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

      onStream?.({ type: "tool_call", name: parsed.name, args: parsed.args });

      const skill = tools.find(t => t.name === parsed.name);

      let output = "";
      let error: string | undefined;
      const startTime = Date.now();

      if (!skill?.execute) {
        error = "Tool not found";
      } else {
        // Per-user skill quota check (expensive skills only)
        const skillQuota = checkSkillQuota(msg.userId, parsed.name);
        if (!skillQuota.allowed) {
          error = `Quota exceeded: ${parsed.name} is rate-limited (${skillQuota.remaining} remaining this hour)`;
        } else {
          // Loop guard: detect repeated identical calls
          const loopCheck = checkLoop(sid, parsed.name, parsed.args);
          if (!loopCheck.allowed) {
            error = `Loop guard: ${loopCheck.reason}`;
          } else {
            try {
              validateArgs(parsed.args, msg.channel, sid);
              output = await skill.execute(parsed.args, msg);
            } catch (err: any) {
              error = err.message;
            }
          }
        }
      }

      const durationMs = Date.now() - startTime;

      // Log tool execution to audit trail
      auditLogger.logToolExec(
        parsed.name, parsed.args, msg.channel, sid,
        durationMs, !error, error
      );

      toolResults.push({ name: parsed.name, output, error });
      onStream?.({ type: "tool_result", name: parsed.name, output, error });

      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: error ? `Error: ${error}` : output
      });
    }
  }

  const finalText = "Stopped: iteration limit reached.";
  log(msg.id, { final: finalText, toolResults });

  appendToSession(session, { role: "assistant", content: finalText, ts: Date.now() });
  saveSession(session);

  return { final: finalText, toolResults, sessionId: sid };
}

function validateArgs(args: any, channel?: string, sessionId?: string) {
  if (!args || typeof args !== "object") return;
  const scan = (val: any) => {
    if (Array.isArray(val)) return val.forEach(scan);
    if (val && typeof val === "object") {
      for (const [k, v] of Object.entries(val)) {
        if (typeof v === "string" && /(command|cmd|script)/i.test(k)) {
          const result = checkSafe(v);
          if (result.blocked) {
            auditLogger.logBlock(
              result.label ?? "unknown",
              v,
              channel ?? "unknown",
              sessionId ?? "unknown",
              result.patternIndex
            );
            throw new Error(`Blocked by SafetySpine [${result.label}]: command matches forbidden pattern`);
          }
        }
        scan(v);
      }
    }
  };
  scan(args);
}
