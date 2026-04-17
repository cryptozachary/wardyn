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
    // For o-series / gpt-5 reasoning models, map thinking level → reasoning_effort.
    // For non-reasoning models the field is ignored server-side.
    const effortMap: Record<string, string | undefined> = {
      off: undefined, minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "high",
    };
    const reasoningEffort = effortMap[payload.thinkingLevel ?? "medium"];
    const model = getModel();
    const supportsEffort = /^(o[134]|gpt-5|gpt-4\.\d-reason)/i.test(model);
    const hasTools = !!(payload.tools?.length);
    const useEffort = supportsEffort && reasoningEffort && !hasTools;

    let res: any;
    try {
      res = await axios.post("https://api.openai.com/v1/chat/completions", {
        model,
        messages: payload.messages,
        tools: hasTools ? payload.tools!.map(t => ({
          type: "function",
          function: {
            name: t.name,
            description: t.description ?? "Skill tool",
            parameters: t.parameters ?? { type: "object", properties: {} }
          }
        })) : undefined,
        ...(useEffort ? { reasoning_effort: reasoningEffort } : {}),
      }, { headers: { Authorization: `Bearer ${apiKey}` } });
    } catch (err: any) {
      const detail = err.response?.data?.error?.message || err.response?.data || err.message;
      console.error(`[openai] API error (model=${model}):`, detail);
      throw err;
    }

    const choice = res.data.choices[0].message;
    const usage = {
      promptTokens: res.data.usage?.prompt_tokens,
      outputTokens: res.data.usage?.completion_tokens,
      cachedTokens: res.data.usage?.prompt_tokens_details?.cached_tokens ?? 0,
      model: res.data.model ?? model,
    };
    if (choice.tool_calls?.length) {
      return { tool_calls: choice.tool_calls, text: null, usage };
    }
    return { tool_calls: null, text: choice.content, usage };
  }
};
