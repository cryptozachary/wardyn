import axios from "axios";
import { readFileSync, existsSync } from "fs";
import path from "path";
import type { LLMProvider, CallPayload, LLMResponse } from "../types.js";

const CONFIG_PATH = path.join(process.cwd(), "config", "ollama.json");

function getConfig(): { url: string; model: string } {
  // Config file takes priority, then env vars, then defaults
  if (existsSync(CONFIG_PATH)) {
    try {
      const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
      return {
        url: cfg.url || process.env.OLLAMA_URL || "http://localhost:11434",
        model: cfg.model || process.env.OLLAMA_MODEL || "llama3.1"
      };
    } catch {}
  }
  return {
    url: process.env.OLLAMA_URL || "http://localhost:11434",
    model: process.env.OLLAMA_MODEL || "llama3.1"
  };
}

export const ollamaProvider: LLMProvider = {
  name: "ollama",

  async callLLM(payload: CallPayload, _apiKey: string): Promise<LLMResponse> {
    const { url, model } = getConfig();
    // Ollama's OpenAI-compatible endpoint
    const res = await axios.post(`${url}/v1/chat/completions`, {
      model,
      messages: payload.messages,
      tools: payload.tools?.length ? payload.tools.map(t => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description ?? "Skill tool",
          parameters: t.parameters ?? { type: "object", properties: {}, additionalProperties: true }
        }
      })) : undefined
    }, { timeout: 120_000 });

    const choice = res.data.choices[0].message;
    if (choice.tool_calls?.length) {
      return { tool_calls: choice.tool_calls, text: null };
    }
    return { tool_calls: null, text: choice.content };
  }
};
