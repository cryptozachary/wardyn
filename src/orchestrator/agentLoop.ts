import { Message, Attachment, ToolCall, ToolResult, SkillMeta, OnStream } from "../types.js";
import { readFileSync, appendFileSync, mkdirSync, existsSync } from "fs";
import path from "path";
import { callLLM } from "../llm/router.js";
import { readAttachmentContent } from "../uploads/uploadHandler.js";
import { checkSafe } from "../security/safetySpine.js";
import { auditLogger } from "../security/auditLog.js";
import { checkLoop } from "../security/loopGuard.js";
import { checkLLMQuota, checkSkillQuota } from "../security/quotaTracker.js";
import {
  Session, SessionMessage,
  getOrCreateSession, appendToSession, compactIfNeeded, saveSession
} from "./sessionStore.js";

// Phrases that ENTER strategist mode (intentional, not accidental)
const STRATEGIST_ENTRY = /\b(strategist mode|run strategist|find me ideas|idea scan|product scan|viral hunter mode|money maker mode|creator tools mode|leverage builder mode|what should i build|any good ideas|bank this signal|deep scan|show my ideas|idea pipeline|what'?s in the pipeline|show signals|signal bank|idea stats)\b/i;

// Phrases that EXIT strategist mode
const STRATEGIST_EXIT = /\b(exit strategist|stop strategist|done with ideas|leave strategist)\b/i;

// In-memory mode tracker — persists across turns within same session
const activeStrategistSessions = new Map<string, boolean>();

function loadContext(strategistActive: boolean) {
  const memDir = path.join(process.cwd(), "memory");
  const memPath = path.join(memDir, "MEMORY.md");
  const soulPath = path.join(memDir, "SOUL.md");
  const stratPath = path.join(memDir, "STRATEGIST.md");
  const memory = existsSync(memPath) ? readFileSync(memPath, "utf8") : "";
  const soul = existsSync(soulPath) ? readFileSync(soulPath, "utf8") : "";

  // Load strategist instructions only when mode is active
  let strategist = "";
  if (strategistActive) {
    strategist = existsSync(stratPath) ? readFileSync(stratPath, "utf8") : "";
  }

  return { memory, soul, strategist };
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

  // Load or create session — unified across all channels (single-user agent)
  const sid = sessionId ?? "default";

  // Determine strategist mode: entry activates, exit deactivates, otherwise inherit
  if (STRATEGIST_EXIT.test(msg.text)) {
    activeStrategistSessions.delete(sid);
  } else if (STRATEGIST_ENTRY.test(msg.text)) {
    activeStrategistSessions.set(sid, true);
  }
  const strategistActive = activeStrategistSessions.has(sid);

  const ctx = loadContext(strategistActive);
  const toolDefs = tools.map(t => ({ name: t.name, description: t.description, parameters: t.parameters }));
  const toolList = tools.map(t => `- ${t.name}: ${t.description}`).join("\n");
  const strategistBlock = ctx.strategist ? `\n\n${ctx.strategist}` : "";
  const systemPrompt = `${ctx.soul}\n\n${ctx.memory}\n\nAvailable tools:\n${toolList}${strategistBlock}`;
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

  // Add the new user message (multimodal if attachments present)
  const userContent = await buildUserContent(msg.text, msg.attachments);
  messages.push({ role: "user", content: userContent });

  // Track in session (store text-only summary for history)
  const sessionText = msg.attachments?.length
    ? `${msg.text}\n\n[Attachments: ${msg.attachments.map(a => a.name).join(", ")}]`
    : msg.text;
  appendToSession(session, { role: "user", content: sessionText, ts: Date.now() });

  let toolResults: ToolResult[] = [];
  let iterations = 0;

  const maxIterations = Number(process.env.AGENT_MAX_ITERATIONS) || 150;
  while (iterations++ < maxIterations) {
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
      let parsed: ToolCall;
      try {
        parsed = {
          name: tc.function.name,
          args: JSON.parse(tc.function.arguments || "{}")
        };
      } catch (parseErr: any) {
        // LLM produced malformed JSON arguments — feed error back so it can retry
        const errMsg = `Invalid JSON in tool arguments for ${tc.function.name}: ${parseErr.message}. Please retry with properly escaped JSON.`;
        toolResults.push({ name: tc.function.name, output: "", error: errMsg });
        onStream?.({ type: "tool_result", name: tc.function.name, output: "", error: errMsg });
        messages.push({ role: "tool", tool_call_id: tc.id, content: `Error: ${errMsg}` });
        continue;
      }

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
          // Heartbeat jobs make many legitimate tool calls — use relaxed limits
          const loopConfig = msg.channel === "heartbeat"
            ? { maxDuplicates: 6, maxTotalCalls: 200, windowMs: 300_000, cooldownMs: 5_000 }
            : {};
          const loopCheck = checkLoop(sid, parsed.name, parsed.args, loopConfig);
          if (!loopCheck.allowed) {
            error = `Loop guard: ${loopCheck.reason}`;
          } else {
            try {
              validateArgs(parsed.args, msg.channel, sid);
              // Inject caller context so skills can detect autonomous execution
              const argsWithContext = { ...parsed.args, _caller: msg.channel, _channel: msg.channel };
              output = await skill.execute(argsWithContext, msg);
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

/**
 * Build user message content — plain string for text-only, multimodal array
 * for messages with attachments (OpenAI/Anthropic vision format).
 * Async because PDF/DOCX extraction requires async operations.
 */
async function buildUserContent(text: string, attachments?: Attachment[]): Promise<any> {
  if (!attachments?.length) return text;

  const parts: any[] = [];

  // Add text part first
  if (text) {
    parts.push({ type: "text", text });
  }

  // Add each attachment as appropriate content block
  for (const att of attachments) {
    const content = await readAttachmentContent(att);
    switch (content.type) {
      case "image":
        parts.push({
          type: "image_url",
          image_url: { url: `data:${content.mimeType};base64,${content.base64}` },
        });
        break;
      case "text":
        parts.push({
          type: "text",
          text: `--- File: ${att.name} ---\n${content.content}\n--- End of ${att.name} ---`,
        });
        break;
      case "file":
        parts.push({ type: "text", text: content.description });
        break;
    }
  }

  return parts;
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
