import axios from "axios";
import { readFileSync, existsSync } from "fs";
import path from "path";
import type { LLMProvider, CallPayload, LLMResponse } from "../types.js";

const MODELS_PATH = path.join(process.cwd(), "config", "models.json");
const API_URL = "https://api.anthropic.com/v1/messages";

function getModel(): string {
  if (existsSync(MODELS_PATH)) {
    try {
      const cfg = JSON.parse(readFileSync(MODELS_PATH, "utf8"));
      if (cfg.anthropic) return cfg.anthropic;
    } catch {}
  }
  return process.env.ANTHROPIC_MODEL || "claude-sonnet-4-20250514";
}

export const anthropicProvider: LLMProvider = {
  name: "anthropic",

  async callLLM(payload: CallPayload, apiKey: string): Promise<LLMResponse> {
    // Convert OpenAI-style messages to Anthropic format
    const systemMessages = payload.messages.filter(m => m.role === "system");
    const system = systemMessages.map(m => m.content).filter(Boolean).join("\n\n");

    const messages = convertMessages(payload.messages.filter(m => m.role !== "system"));

    const tools = payload.tools?.length ? payload.tools.map(t => ({
      name: t.name,
      description: t.description ?? "Skill tool",
      input_schema: t.parameters ?? { type: "object" as const, properties: {} }
    })) : undefined;

    const res = await axios.post(API_URL, {
      model: getModel(),
      max_tokens: 4096,
      system,
      messages,
      tools
    }, {
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
      }
    });

    return parseResponse(res.data);
  }
};

function convertMessages(msgs: CallPayload["messages"]): any[] {
  const result: any[] = [];

  for (const msg of msgs) {
    if (msg.role === "assistant" && msg.tool_calls?.length) {
      // Convert OpenAI tool_calls to Anthropic tool_use content blocks
      const content: any[] = [];
      if (msg.content) content.push({ type: "text", text: msg.content });
      for (const tc of msg.tool_calls) {
        content.push({
          type: "tool_use",
          id: tc.id,
          name: tc.function.name,
          input: JSON.parse(tc.function.arguments || "{}")
        });
      }
      result.push({ role: "assistant", content });
    } else if (msg.role === "tool") {
      // Convert OpenAI tool result to Anthropic tool_result
      // Merge consecutive tool results into one user message
      const last = result[result.length - 1];
      const block = {
        type: "tool_result",
        tool_use_id: msg.tool_call_id,
        content: msg.content ?? ""
      };
      if (last?.role === "user" && Array.isArray(last.content) && last.content[0]?.type === "tool_result") {
        last.content.push(block);
      } else {
        result.push({ role: "user", content: [block] });
      }
    } else if (msg.role === "user" && Array.isArray(msg.content)) {
      // Multimodal content — convert OpenAI image_url blocks to Anthropic image blocks
      const content: any[] = [];
      for (const part of msg.content) {
        if (part.type === "text") {
          content.push({ type: "text", text: part.text });
        } else if (part.type === "image_url") {
          const url: string = part.image_url?.url ?? "";
          const match = url.match(/^data:([^;]+);base64,(.+)$/);
          if (match) {
            content.push({
              type: "image",
              source: { type: "base64", media_type: match[1], data: match[2] },
            });
          }
        }
      }
      result.push({ role: "user", content });
    } else {
      result.push({ role: msg.role, content: msg.content ?? "" });
    }
  }

  return result;
}

function parseResponse(data: any): LLMResponse {
  const content = data.content ?? [];

  // Check for tool use
  const toolUseBlocks = content.filter((b: any) => b.type === "tool_use");
  if (toolUseBlocks.length > 0) {
    // Normalize to OpenAI tool_calls format so agentLoop doesn't need to change
    const tool_calls = toolUseBlocks.map((b: any) => ({
      id: b.id,
      type: "function",
      function: {
        name: b.name,
        arguments: JSON.stringify(b.input ?? {})
      }
    }));
    return { tool_calls, text: null };
  }

  // Extract text
  const textBlocks = content.filter((b: any) => b.type === "text");
  const text = textBlocks.map((b: any) => b.text).join("\n") || null;
  return { tool_calls: null, text };
}
