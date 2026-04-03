import axios from "axios";
import { readFileSync, existsSync } from "fs";
import path from "path";
import type { LLMProvider, CallPayload, LLMResponse } from "../types.js";

const MODELS_PATH = path.join(process.cwd(), "config", "models.json");

function getModel(): string {
  if (existsSync(MODELS_PATH)) {
    try {
      const cfg = JSON.parse(readFileSync(MODELS_PATH, "utf8"));
      if (cfg.openai) return cfg.openai;
    } catch {}
  }
  return process.env.OPENAI_MODEL || "gpt-4o-mini";
}

export const openaiProvider: LLMProvider = {
  name: "openai",

  async callLLM(payload: CallPayload, apiKey: string): Promise<LLMResponse> {
    const res = await axios.post("https://api.openai.com/v1/chat/completions", {
      model: getModel(),
      messages: payload.messages,
      tools: payload.tools?.length ? payload.tools.map(t => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description ?? "Skill tool",
          parameters: t.parameters ?? { type: "object", properties: {}, additionalProperties: true }
        }
      })) : undefined
    }, { headers: { Authorization: `Bearer ${apiKey}` } });

    const choice = res.data.choices[0].message;
    if (choice.tool_calls?.length) {
      return { tool_calls: choice.tool_calls, text: null };
    }
    return { tool_calls: null, text: choice.content };
  }
};
