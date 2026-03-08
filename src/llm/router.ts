import type { CallPayload, LLMProvider, LLMResponse } from "./types.js";
import { openaiProvider } from "./providers/openai.js";
import { anthropicProvider } from "./providers/anthropic.js";
import { ollamaProvider } from "./providers/ollama.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import path from "path";

const providers: Record<string, LLMProvider> = {
  openai: openaiProvider,
  anthropic: anthropicProvider,
  ollama: ollamaProvider
};

const ENV_PROVIDER = process.env.LLM_PROVIDER || "openai";
const PROVIDER_CONFIG_PATH = path.join(process.cwd(), "config", "provider.json");

export function getProviderName(): string {
  // Config file takes priority over env var
  if (existsSync(PROVIDER_CONFIG_PATH)) {
    try {
      const cfg = JSON.parse(readFileSync(PROVIDER_CONFIG_PATH, "utf8"));
      if (cfg.provider && providers[cfg.provider]) return cfg.provider;
    } catch {}
  }
  return ENV_PROVIDER;
}

export function setProviderName(name: string): void {
  if (!providers[name]) throw new Error(`Unknown provider: "${name}". Available: ${Object.keys(providers).join(", ")}`);
  const cfgDir = path.join(process.cwd(), "config");
  if (!existsSync(cfgDir)) mkdirSync(cfgDir, { recursive: true });
  writeFileSync(PROVIDER_CONFIG_PATH, JSON.stringify({ provider: name }, null, 2), "utf8");
}

export function getProvider(name?: string): LLMProvider {
  const key = name || getProviderName();
  const provider = providers[key];
  if (!provider) throw new Error(`Unknown LLM provider: "${key}". Available: ${Object.keys(providers).join(", ")}`);
  return provider;
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
