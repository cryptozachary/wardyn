import axios from "axios";
import type { LLMProvider, CallPayload, LLMResponse } from "../types.js";

const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

export const openaiProvider: LLMProvider = {
  name: "openai",

  async callLLM(payload: CallPayload, apiKey: string): Promise<LLMResponse> {
    const res = await axios.post("https://api.openai.com/v1/chat/completions", {
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
    }, { headers: { Authorization: `Bearer ${apiKey}` } });

    const choice = res.data.choices[0].message;
    if (choice.tool_calls?.length) {
      return { tool_calls: choice.tool_calls, text: null };
    }
    return { tool_calls: null, text: choice.content };
  }
};
