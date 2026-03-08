import type { CallPayload, LLMProvider, LLMResponse } from "./types.js";
import { openaiProvider } from "./providers/openai.js";
import { anthropicProvider } from "./providers/anthropic.js";
import { ollamaProvider } from "./providers/ollama.js";

const providers: Record<string, LLMProvider> = {
  openai: openaiProvider,
  anthropic: anthropicProvider,
  ollama: ollamaProvider
};

const DEFAULT_PROVIDER = process.env.LLM_PROVIDER || "openai";

export function getProvider(name?: string): LLMProvider {
  const key = name || DEFAULT_PROVIDER;
  const provider = providers[key];
  if (!provider) throw new Error(`Unknown LLM provider: "${key}". Available: ${Object.keys(providers).join(", ")}`);
  return provider;
}

export function getProviderName(): string {
  return DEFAULT_PROVIDER;
}

export async function callLLM(payload: CallPayload, apiKey: string, providerName?: string): Promise<LLMResponse> {
  const provider = getProvider(providerName);
  try {
    return await provider.callLLM(payload, apiKey);
  } catch (err: any) {
    const msg = err.response?.data?.error?.message
      || err.response?.data?.error?.type
      || err.message
      || "LLM call failed";
    throw new Error(`[${provider.name}] ${msg}`);
  }
}

// Re-export types for convenience
export type { CallPayload, LLMResponse, LLMProvider, ToolDef, ChatMessage } from "./types.js";
