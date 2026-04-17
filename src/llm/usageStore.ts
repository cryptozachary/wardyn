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

export interface UsageRecord {
  ts: number;
  provider: string;
  model?: string;
  sessionId?: string;
  channel?: string;
  promptTokens?: number;
  outputTokens?: number;
  durationMs: number;
  fallbackUsed: boolean;
  error?: string;
}

interface PriceRow { input: number; output: number }

const DEFAULT_PRICES: Record<string, PriceRow> = {
  // USD per 1M tokens — rough order-of-magnitude defaults.
  "gpt-4o-mini":                { input: 0.15,  output: 0.60 },
  "gpt-4o":                     { input: 2.50,  output: 10.00 },
  "claude-sonnet-4-20250514":   { input: 3.00,  output: 15.00 },
  "claude-opus-4-20250514":     { input: 15.00, output: 75.00 },
  "claude-haiku-4-5-20251001":  { input: 1.00,  output: 5.00 },
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

export function estimateCost(model: string | undefined, inTokens: number, outTokens: number): number | undefined {
  if (!model) return undefined;
  const prices = getPrices();
  const row = prices[model];
  if (!row) return undefined;
  return (inTokens / 1_000_000) * row.input + (outTokens / 1_000_000) * row.output;
}

export function recordUsage(r: UsageRecord): void {
  try {
    const cost = estimateCost(r.model, r.promptTokens ?? 0, r.outputTokens ?? 0);
    getDb().prepare(
      `INSERT INTO llm_usage
         (ts, provider, model, session_id, channel, prompt_tokens, output_tokens,
          duration_ms, cost_usd, fallback_used, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      r.ts, r.provider, r.model ?? null, r.sessionId ?? null, r.channel ?? null,
      r.promptTokens ?? null, r.outputTokens ?? null,
      r.durationMs, cost ?? null, r.fallbackUsed ? 1 : 0, r.error ?? null,
    );
  } catch {}
}

export interface UsageSummary {
  windowHours: number;
  totalCalls: number;
  totalPromptTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  avgLatencyMs: number;
  byProvider: Array<{ provider: string; calls: number; tokens: number; costUsd: number }>;
  byModel: Array<{ model: string; calls: number; tokens: number; costUsd: number }>;
}

export function getUsageSummary(hours = 24): UsageSummary {
  const db = getDb();
  const since = Date.now() - hours * 3_600_000;
  const rows = db.prepare("SELECT * FROM llm_usage WHERE ts >= ?").all(since) as any[];

  let totalCalls = rows.length;
  let inTok = 0, outTok = 0, cost = 0, dur = 0, durN = 0;
  const byProv = new Map<string, { calls: number; tokens: number; costUsd: number }>();
  const byModel = new Map<string, { calls: number; tokens: number; costUsd: number }>();

  for (const r of rows) {
    const pTok = r.prompt_tokens ?? 0;
    const oTok = r.output_tokens ?? 0;
    inTok += pTok;
    outTok += oTok;
    cost += r.cost_usd ?? 0;
    if (r.duration_ms != null) { dur += r.duration_ms; durN++; }
    const p = byProv.get(r.provider) ?? { calls: 0, tokens: 0, costUsd: 0 };
    p.calls++; p.tokens += pTok + oTok; p.costUsd += r.cost_usd ?? 0;
    byProv.set(r.provider, p);
    if (r.model) {
      const m = byModel.get(r.model) ?? { calls: 0, tokens: 0, costUsd: 0 };
      m.calls++; m.tokens += pTok + oTok; m.costUsd += r.cost_usd ?? 0;
      byModel.set(r.model, m);
    }
  }

  return {
    windowHours: hours,
    totalCalls,
    totalPromptTokens: inTok,
    totalOutputTokens: outTok,
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
  const daily = Number(process.env.LLM_DAILY_BUDGET_USD);
  if (!Number.isFinite(daily) || daily <= 0) return false;
  const db = getDb();
  const since = Date.now() - 24 * 3_600_000;
  const row = db.prepare("SELECT SUM(cost_usd) as c FROM llm_usage WHERE ts >= ?").get(since) as any;
  return (row?.c ?? 0) >= daily;
}
