import type { CallPayload, LLMProvider, LLMResponse } from "./types.js";
import { openaiProvider } from "./providers/openai.js";
import { anthropicProvider } from "./providers/anthropic.js";
import { ollamaProvider } from "./providers/ollama.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import path from "path";
import { loadKeys } from "../security/keyVault.js";
import { recordUsage, isBudgetExceeded } from "./usageStore.js";

export interface CallContext {
  sessionId?: string;
  channel?: string;
}

const providers: Record<string, LLMProvider> = {
  openai: openaiProvider,
  anthropic: anthropicProvider,
  ollama: ollamaProvider
};

const ENV_PROVIDER = process.env.LLM_PROVIDER || "openai";
const PROVIDER_CONFIG_PATH = path.join(process.cwd(), "config", "provider.json");
const MODELS_CONFIG_PATH = path.join(process.cwd(), "config", "models.json");

// Fallback order: try primary, then each fallback in sequence
const FALLBACK_ORDER: string[] = (process.env.LLM_FALLBACK_ORDER || "openai,anthropic,ollama")
  .split(",")
  .map(s => s.trim())
  .filter(s => providers[s]);

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

const MODEL_DEFAULTS: Record<string, string> = {
  openai: process.env.OPENAI_MODEL || "gpt-5.4",
  anthropic: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6",
};

export function getModelConfig(): Record<string, string> {
  const cfg: Record<string, string> = { ...MODEL_DEFAULTS };
  if (existsSync(MODELS_CONFIG_PATH)) {
    try {
      const saved = JSON.parse(readFileSync(MODELS_CONFIG_PATH, "utf8"));
      for (const [k, v] of Object.entries(saved)) {
        if (typeof v === "string") cfg[k] = v;
      }
    } catch {}
  }
  // Ollama model is in its own config
  if (existsSync(path.join(process.cwd(), "config", "ollama.json"))) {
    try {
      const ollCfg = JSON.parse(readFileSync(path.join(process.cwd(), "config", "ollama.json"), "utf8"));
      if (ollCfg.model) cfg.ollama = ollCfg.model;
    } catch {}
  }
  return cfg;
}

export function setModel(provider: string, model: string): void {
  if (!model || typeof model !== "string") throw new Error("model is required");
  const cfgDir = path.join(process.cwd(), "config");
  if (!existsSync(cfgDir)) mkdirSync(cfgDir, { recursive: true });

  let existing: Record<string, string> = {};
  if (existsSync(MODELS_CONFIG_PATH)) {
    try { existing = JSON.parse(readFileSync(MODELS_CONFIG_PATH, "utf8")); } catch {}
  }
  existing[provider] = model;
  writeFileSync(MODELS_CONFIG_PATH, JSON.stringify(existing, null, 2), "utf8");
}

export function getProvider(name?: string): LLMProvider {
  const key = name || getProviderName();
  const provider = providers[key];
  if (!provider) throw new Error(`Unknown LLM provider: "${key}". Available: ${Object.keys(providers).join(", ")}`);
  return provider;
}

/**
 * Call LLM with automatic fallback routing.
 * If the primary provider fails, tries each fallback provider in order.
 * Logs which provider was used on fallback.
 */
export async function callLLM(
  payload: CallPayload,
  apiKey: string,
  providerName?: string,
  ctx?: CallContext,
): Promise<LLMResponse> {
  const primaryName = providerName || getProviderName();
  const provider = providers[primaryName];
  if (!provider) throw new Error(`Unknown LLM provider: "${primaryName}"`);

  // Enforce optional daily budget (set via LLM_DAILY_BUDGET_USD).
  if (isBudgetExceeded()) {
    throw new Error("LLM daily budget exceeded — refusing new calls. Raise LLM_DAILY_BUDGET_USD or wait for rollover.");
  }

  const trace = (
    name: string,
    fallback: boolean,
    fn: () => Promise<LLMResponse>,
  ): Promise<LLMResponse> => {
    const started = Date.now();
    return fn().then(
      (res) => {
        recordUsage({
          ts: started,
          provider: name,
          model: res.usage?.model,
          sessionId: ctx?.sessionId,
          channel: ctx?.channel,
          promptTokens: res.usage?.promptTokens,
          outputTokens: res.usage?.outputTokens,
          cachedTokens: res.usage?.cachedTokens,
          cacheWriteTokens: res.usage?.cacheWriteTokens,
          durationMs: Date.now() - started,
          fallbackUsed: fallback,
        });
        return res;
      },
      (err) => {
        recordUsage({
          ts: started,
          provider: name,
          sessionId: ctx?.sessionId,
          channel: ctx?.channel,
          durationMs: Date.now() - started,
          fallbackUsed: fallback,
          error: (err?.message ?? String(err)).slice(0, 400),
        });
        throw err;
      },
    );
  };

  // Try primary provider first
  try {
    return await trace(primaryName, false, () => provider.callLLM(payload, apiKey));
  } catch (primaryErr: any) {
    // If a specific provider was requested, don't fallback
    if (providerName) {
      throw formatError(provider.name, primaryErr);
    }

    // Build fallback list: all providers except the primary that failed
    const fallbacks = FALLBACK_ORDER.filter(name => name !== primaryName);

    if (fallbacks.length === 0) {
      throw formatError(provider.name, primaryErr);
    }

    const detail = primaryErr.response?.data?.error?.message
      || primaryErr.response?.data?.error
      || primaryErr.message;
    console.warn(
      `[router] Primary provider ${primaryName} failed: ${detail}. Trying fallbacks: ${fallbacks.join(", ")}`
    );

    // Try each fallback
    const errors: string[] = [`${primaryName}: ${primaryErr.message}`];

    for (const fbName of fallbacks) {
      const fbProvider = providers[fbName];
      if (!fbProvider) continue;

      // Need an API key for the fallback provider
      // Try to get it from env vars
      const fbKey = getFallbackKey(fbName, apiKey);
      if (!fbKey) {
        errors.push(`${fbName}: no API key configured`);
        continue;
      }

      try {
        console.warn(`[router] Trying fallback provider: ${fbName}`);
        const result = await trace(fbName, true, () => fbProvider.callLLM(payload, fbKey));
        console.warn(`[router] Fallback ${fbName} succeeded`);
        return result;
      } catch (fbErr: any) {
        errors.push(`${fbName}: ${fbErr.message}`);
        continue;
      }
    }

    // All providers failed
    throw new Error(
      `All LLM providers failed:\n${errors.map(e => `  - ${e}`).join("\n")}`
    );
  }
}

/** Try to find an API key for a fallback provider. */
function getFallbackKey(providerName: string, currentKey: string): string | null {
  // Check env vars first
  if (providerName === "openai" && process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  if (providerName === "anthropic" && process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  if (providerName === "ollama") return "ollama-local"; // Ollama doesn't need a key

  // Try loading from encrypted vault
  try {
    const keys = loadKeys(process.env.KEY_PASSPHRASE ?? "");
    if (keys[providerName]) return keys[providerName];
  } catch {}

  // Last resort: use the current key (works if same provider type)
  return null;
}

function formatError(providerName: string, err: any): Error {
  const msg = err.response?.data?.error?.message
    || err.response?.data?.error?.type
    || err.message
    || "LLM call failed";
  return new Error(`[${providerName}] ${msg}`);
}

// Re-export types for convenience
export type { CallPayload, LLMResponse, LLMProvider, ToolDef, ChatMessage } from "./types.js";
