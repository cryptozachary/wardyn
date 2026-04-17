/**
 * LLM usage + cost tracking. Every callLLM invocation records provider,
 * model, token counts, latency, fallback status, and estimated cost into
 * the llm_usage table.
 *
 * Cost estimates use a small static price table — override via
 * config/llm-pricing.json if you need precise numbers.
 */

import { existsSync, readFileSync } from "fs";
import path from "path";
import { getDb } from "../db.js";
import { getSettingNumber } from "../security/settingsStore.js";

export interface UsageRecord {
  ts: number;
  provider: string;
  model?: string;
  sessionId?: string;
  channel?: string;
  /** Total input tokens including any cache reads and cache writes. */
  promptTokens?: number;
  outputTokens?: number;
  /** Subset of promptTokens that was served from cache (cheap read). */
  cachedTokens?: number;
  /** Subset of promptTokens that wrote to cache (Anthropic only; priced higher). */
  cacheWriteTokens?: number;
  durationMs: number;
  fallbackUsed: boolean;
  error?: string;
}

interface PriceRow {
  /** USD per 1M uncached input tokens. */
  input: number;
  /** USD per 1M output tokens. */
  output: number;
  /** USD per 1M cached-input tokens (cache read). Defaults to `input` when unset. */
  cachedInput?: number;
  /** USD per 1M cache-write tokens (Anthropic 5m-TTL write rate). Defaults to `input`. */
  cacheWrite?: number;
  /** Long-context rates kick in when promptTokens > longThreshold. */
  longInput?: number;
  longCachedInput?: number;
  longOutput?: number;
  longThreshold?: number;
}

const DEFAULT_PRICES: Record<string, PriceRow> = {
  // ───── OpenAI GPT-5.4 family (USD / 1M tokens) ─────
  // Long-context rates apply to prompts > 128k tokens on the models that have a long tier.
  "gpt-5.4":      { input: 2.50,  cachedInput: 0.25,  output: 15.00,
                    longInput: 5.00, longCachedInput: 0.50, longOutput: 22.50, longThreshold: 128_000 },
  "gpt-5.4-mini": { input: 0.75,  cachedInput: 0.075, output: 4.50 },
  "gpt-5.4-nano": { input: 0.20,  cachedInput: 0.02,  output: 1.25 },
  "gpt-5.4-pro":  { input: 30.00, output: 180.00,
                    longInput: 60.00, longOutput: 270.00, longThreshold: 128_000 },

  // Legacy OpenAI (kept so old usage rows still cost correctly)
  "gpt-4o-mini": { input: 0.15, output: 0.60 },
  "gpt-4o":      { input: 2.50, output: 10.00 },

  // ───── Anthropic Claude family (USD / 1M tokens, 5m-TTL cache writes) ─────
  "claude-sonnet-4-6": { input: 3.00,  cachedInput: 0.30, cacheWrite: 3.75,  output: 15.00 },
  "claude-opus-4-7":   { input: 5.00,  cachedInput: 0.50, cacheWrite: 6.25,  output: 25.00 },
  "claude-opus-4-6":   { input: 5.00,  cachedInput: 0.50, cacheWrite: 6.25,  output: 25.00 },
  "claude-opus-4-5":   { input: 5.00,  cachedInput: 0.50, cacheWrite: 6.25,  output: 25.00 },
  "claude-opus-4-1":   { input: 15.00, cachedInput: 1.50, cacheWrite: 18.75, output: 75.00 },
  "claude-opus-4":     { input: 15.00, cachedInput: 1.50, cacheWrite: 18.75, output: 75.00 },
};

let priceCache: Record<string, PriceRow> | null = null;
function getPrices(): Record<string, PriceRow> {
  if (priceCache) return priceCache;
  priceCache = { ...DEFAULT_PRICES };
  const custom = path.join(process.cwd(), "config", "llm-pricing.json");
  if (existsSync(custom)) {
    try {
      const raw = JSON.parse(readFileSync(custom, "utf8"));
      for (const [k, v] of Object.entries(raw as Record<string, PriceRow>)) {
        priceCache[k] = v;
      }
    } catch {}
  }
  return priceCache;
}

/**
 * Estimate per-call cost in USD.
 *
 * `inTokens` is the total input token count (uncached + cached reads + cache writes).
 * Pass `cachedTokens` (cache reads, charged at `cachedInput` rate) and
 * `cacheWriteTokens` (Anthropic-only cache writes, charged at `cacheWrite` rate)
 * separately — both are subsets of `inTokens`, so the remainder is billed at the
 * standard `input` rate.
 *
 * For models with a long-context tier (e.g. gpt-5.4), prompts over `longThreshold`
 * tokens use the `long*` rates.
 */
export function estimateCost(
  model: string | undefined,
  inTokens: number,
  outTokens: number,
  cachedTokens = 0,
  cacheWriteTokens = 0,
): number | undefined {
  if (!model) return undefined;
  const prices = getPrices();
  const row = prices[model];
  if (!row) return undefined;

  const isLong = row.longThreshold != null && inTokens > row.longThreshold;
  const inputRate  = isLong && row.longInput       != null ? row.longInput       : row.input;
  const cachedRate = isLong && row.longCachedInput != null ? row.longCachedInput : (row.cachedInput ?? inputRate);
  const outputRate = isLong && row.longOutput      != null ? row.longOutput      : row.output;
  const writeRate  = row.cacheWrite ?? inputRate;

  const cached = Math.max(0, cachedTokens);
  const writes = Math.max(0, cacheWriteTokens);
  const uncached = Math.max(0, inTokens - cached - writes);

  return (
    (uncached / 1_000_000) * inputRate  +
    (cached   / 1_000_000) * cachedRate +
    (writes   / 1_000_000) * writeRate  +
    (outTokens / 1_000_000) * outputRate
  );
}

export function recordUsage(r: UsageRecord): void {
  try {
    const cost = estimateCost(
      r.model,
      r.promptTokens ?? 0,
      r.outputTokens ?? 0,
      r.cachedTokens ?? 0,
      r.cacheWriteTokens ?? 0,
    );
    getDb().prepare(
      `INSERT INTO llm_usage
         (ts, provider, model, session_id, channel, prompt_tokens, output_tokens,
          cached_tokens, cache_write_tokens,
          duration_ms, cost_usd, fallback_used, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      r.ts, r.provider, r.model ?? null, r.sessionId ?? null, r.channel ?? null,
      r.promptTokens ?? null, r.outputTokens ?? null,
      r.cachedTokens ?? null, r.cacheWriteTokens ?? null,
      r.durationMs, cost ?? null, r.fallbackUsed ? 1 : 0, r.error ?? null,
    );
  } catch {}
}

export interface UsageSummary {
  windowHours: number;
  totalCalls: number;
  totalPromptTokens: number;
  totalOutputTokens: number;
  totalCachedTokens: number;
  totalCacheWriteTokens: number;
  totalCostUsd: number;
  avgLatencyMs: number;
  byProvider: Array<{ provider: string; calls: number; tokens: number; costUsd: number }>;
  byModel: Array<{ model: string; calls: number; tokens: number; cachedTokens: number; costUsd: number }>;
}

export function getUsageSummary(hours = 24): UsageSummary {
  const db = getDb();
  const since = Date.now() - hours * 3_600_000;
  const rows = db.prepare("SELECT * FROM llm_usage WHERE ts >= ?").all(since) as any[];

  let totalCalls = rows.length;
  let inTok = 0, outTok = 0, cachedTok = 0, writeTok = 0, cost = 0, dur = 0, durN = 0;
  const byProv = new Map<string, { calls: number; tokens: number; costUsd: number }>();
  const byModel = new Map<string, { calls: number; tokens: number; cachedTokens: number; costUsd: number }>();

  for (const r of rows) {
    const pTok = r.prompt_tokens ?? 0;
    const oTok = r.output_tokens ?? 0;
    const cTok = r.cached_tokens ?? 0;
    const wTok = r.cache_write_tokens ?? 0;
    inTok += pTok;
    outTok += oTok;
    cachedTok += cTok;
    writeTok += wTok;
    cost += r.cost_usd ?? 0;
    if (r.duration_ms != null) { dur += r.duration_ms; durN++; }
    const p = byProv.get(r.provider) ?? { calls: 0, tokens: 0, costUsd: 0 };
    p.calls++; p.tokens += pTok + oTok; p.costUsd += r.cost_usd ?? 0;
    byProv.set(r.provider, p);
    if (r.model) {
      const m = byModel.get(r.model) ?? { calls: 0, tokens: 0, cachedTokens: 0, costUsd: 0 };
      m.calls++; m.tokens += pTok + oTok; m.cachedTokens += cTok; m.costUsd += r.cost_usd ?? 0;
      byModel.set(r.model, m);
    }
  }

  return {
    windowHours: hours,
    totalCalls,
    totalPromptTokens: inTok,
    totalOutputTokens: outTok,
    totalCachedTokens: cachedTok,
    totalCacheWriteTokens: writeTok,
    totalCostUsd: cost,
    avgLatencyMs: durN > 0 ? Math.round(dur / durN) : 0,
    byProvider: Array.from(byProv.entries()).map(([provider, v]) => ({ provider, ...v })),
    byModel: Array.from(byModel.entries()).map(([model, v]) => ({ model, ...v })),
  };
}

/**
 * Enforce a configurable daily budget in USD. Returns true when the caller
 * would exceed the limit — the caller should refuse the request.
 */
export function isBudgetExceeded(): boolean {
  // Read through the settings store so a live UI override takes effect
  // immediately. The store falls back to process.env and then to no-cap.
  const daily = getSettingNumber("LLM_DAILY_BUDGET_USD");
  if (daily == null || !Number.isFinite(daily) || daily <= 0) return false;
  const db = getDb();
  const since = Date.now() - 24 * 3_600_000;
  const row = db.prepare("SELECT SUM(cost_usd) as c FROM llm_usage WHERE ts >= ?").get(since) as any;
  return (row?.c ?? 0) >= daily;
}
