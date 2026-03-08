import axios from "axios";
import type { LLMProvider, CallPayload, LLMResponse } from "../types.js";

const MODEL = process.env.OLLAMA_MODEL || "llama3.1";
const BASE_URL = process.env.OLLAMA_URL || "http://localhost:11434";

export const ollamaProvider: LLMProvider = {
  name: "ollama",

  async callLLM(payload: CallPayload, _apiKey: string): Promise<LLMResponse> {
    // Ollama's OpenAI-compatible endpoint
    const res = await axios.post(`${BASE_URL}/v1/chat/completions`, {
      model: MODEL,
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
