import { promises as fs } from "fs";
import path from "path";
import crypto from "crypto";

export const parameters = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["scan", "watchlist", "add_watchlist", "remove_watchlist", "presets"],
      description:
        "Action: scan (run strategy against watchlist), watchlist (view current), add_watchlist (add symbols), remove_watchlist (remove symbols), presets (list built-in strategies).",
    },
    // scan args
    symbols: {
      type: "array",
      items: { type: "string" },
      description: "Symbols to scan. If omitted, uses the saved watchlist.",
    },
    strategy: {
      type: "string",
      description:
        'Strategy name or custom expression. Built-in: "oversold", "overbought", "macd_cross", "volume_spike", "bollinger_squeeze", "momentum", "trend_reversal", "full_analysis". Or custom: "rsi < 30 AND macd_hist > 0".',
    },
    exchange: { type: "string", description: "Exchange (default: binance)" },
    interval: { type: "string", description: "Interval (default: 1d)" },
    assetType: { type: "string", enum: ["crypto", "stocks"], description: "Asset type (default: crypto)" },
    maxResults: { type: "number", description: "Max matching symbols to return (default: 20)" },
    sortBy: { type: "string", description: "Sort results by field (e.g. rsi, volume, price). Default: relevance." },
    sortOrder: { type: "string", enum: ["asc", "desc"], description: "Sort order (default: desc)" },

    // watchlist management
    watchlistName: { type: "string", description: "Watchlist name (default: 'default')" },
  },
  required: ["action"],
};

/* ────────────────────── constants ────────────────────── */

const CONFIG_DIR = path.join(process.cwd(), "config");
const WATCHLIST_PATH = path.join(CONFIG_DIR, "watchlists.json");
const MAX_SCAN_SYMBOLS = 50;
const SCAN_TIMEOUT = 60000; // 60s total
const PER_SYMBOL_TIMEOUT = 15000;

// Default watchlists
const DEFAULT_CRYPTO_WATCHLIST = [
  "BTC/USDT", "ETH/USDT", "SOL/USDT", "BNB/USDT", "XRP/USDT",
  "ADA/USDT", "AVAX/USDT", "DOGE/USDT", "DOT/USDT", "MATIC/USDT",
  "LINK/USDT", "UNI/USDT", "ATOM/USDT", "LTC/USDT", "NEAR/USDT",
  "APT/USDT", "OP/USDT", "ARB/USDT", "FIL/USDT", "INJ/USDT",
];

/* ────────────────────── built-in strategies ────────────────────── */

interface StrategyDef {
  name: string;
  description: string;
  indicators: Array<{ indicator: string; period?: number; [key: string]: any }>;
  filter: (data: Record<string, any>) => boolean;
  score: (data: Record<string, any>) => number;
}

const BUILT_IN_STRATEGIES: Record<string, StrategyDef> = {
  oversold: {
    name: "Oversold",
    description: "RSI below 30, potential bounce candidates",
    indicators: [{ indicator: "rsi" }, { indicator: "stochrsi" }, { indicator: "mfi" }],
    filter: (d) => val(d, "rsi", "value") < 35,
    score: (d) => 35 - val(d, "rsi", "value"), // lower RSI = higher score
  },
  overbought: {
    name: "Overbought",
    description: "RSI above 70, potential short/exit candidates",
    indicators: [{ indicator: "rsi" }, { indicator: "stochrsi" }, { indicator: "mfi" }],
    filter: (d) => val(d, "rsi", "value") > 65,
    score: (d) => val(d, "rsi", "value") - 65,
  },
  macd_cross: {
    name: "MACD Cross",
    description: "MACD histogram crossing zero (bullish or bearish signal)",
    indicators: [
      { indicator: "macd", id: "macd_now" },
      { indicator: "macd", id: "macd_prev", backtrack: 1 },
    ],
    filter: (d) => {
      const now = val(d, "macd_now", "valueMACDHist");
      const prev = val(d, "macd_prev", "valueMACDHist");
      return (now > 0 && prev <= 0) || (now < 0 && prev >= 0);
    },
    score: (d) => Math.abs(val(d, "macd_now", "valueMACDHist")),
  },
  volume_spike: {
    name: "Volume Spike",
    description: "Current volume significantly above average (potential breakout)",
    indicators: [
      { indicator: "volume", id: "vol_now" },
      { indicator: "sma", id: "vol_avg", period: 20 },
    ],
    filter: (d) => {
      const now = val(d, "vol_now", "value");
      const avg = val(d, "vol_avg", "value");
      return avg > 0 && now > avg * 1.5;
    },
    score: (d) => {
      const avg = val(d, "vol_avg", "value");
      return avg > 0 ? val(d, "vol_now", "value") / avg : 0;
    },
  },
  bollinger_squeeze: {
    name: "Bollinger Squeeze",
    description: "Bollinger Band width narrowing (consolidation before breakout)",
    indicators: [{ indicator: "bbands" }, { indicator: "bbw" }],
    filter: (d) => val(d, "bbw", "value") < 0.1,
    score: (d) => 0.1 - val(d, "bbw", "value"),
  },
  momentum: {
    name: "Momentum",
    description: "Strong upward momentum: RSI 50-70, MACD bullish, ADX > 25",
    indicators: [{ indicator: "rsi" }, { indicator: "macd" }, { indicator: "adx" }],
    filter: (d) => {
      const rsi = val(d, "rsi", "value");
      const macdHist = val(d, "macd", "valueMACDHist");
      const adx = val(d, "adx", "value");
      return rsi > 50 && rsi < 70 && macdHist > 0 && adx > 25;
    },
    score: (d) => val(d, "adx", "value") + val(d, "macd", "valueMACDHist"),
  },
  trend_reversal: {
    name: "Trend Reversal",
    description: "Oversold RSI + bullish MACD crossover + increasing volume",
    indicators: [
      { indicator: "rsi" },
      { indicator: "macd", id: "macd_now" },
      { indicator: "macd", id: "macd_prev", backtrack: 1 },
      { indicator: "volume", id: "vol_now" },
      { indicator: "sma", id: "vol_avg", period: 20 },
    ],
    filter: (d) => {
      const rsi = val(d, "rsi", "value");
      const macdNow = val(d, "macd_now", "valueMACDHist");
      const macdPrev = val(d, "macd_prev", "valueMACDHist");
      const volNow = val(d, "vol_now", "value");
      const volAvg = val(d, "vol_avg", "value");
      return rsi < 40 && macdNow > macdPrev && volAvg > 0 && volNow > volAvg;
    },
    score: (d) => (40 - val(d, "rsi", "value")) + Math.abs(val(d, "macd_now", "valueMACDHist")),
  },
  full_analysis: {
    name: "Full Analysis",
    description: "Returns all key indicators for every symbol (no filter, just data collection)",
    indicators: [
      { indicator: "rsi" },
      { indicator: "macd" },
      { indicator: "bbands" },
      { indicator: "adx" },
      { indicator: "atr" },
      { indicator: "obv" },
      { indicator: "stochrsi" },
    ],
    filter: () => true, // everything passes
    score: () => 0,
  },
};

/* ────────────────────── helpers ────────────────────── */

function val(data: Record<string, any>, indicatorId: string, field: string): number {
  const entry = data[indicatorId];
  if (!entry || entry.status === "error") return 0;
  const v = entry[field];
  return typeof v === "number" ? v : 0;
}

/* ────────────────────── TAAPI integration ────────────────────── */

let taapiExecute: ((args: any) => Promise<string>) | null = null;

async function loadTaapi(): Promise<void> {
  if (taapiExecute) return;
  const candidates = [
    path.join(process.cwd(), "dist", "skills", "taapi_io_price_retriever_skill", "index.js"),
    path.join(process.cwd(), "skills", "taapi_io_price_retriever_skill", "index.js"),
  ];
  for (const p of candidates) {
    try {
      const { existsSync } = require("fs");
      if (existsSync(p)) {
        const mod = await import(p);
        if (mod.execute) {
          taapiExecute = mod.execute;
          return;
        }
      }
    } catch { /* continue */ }
  }
  throw new Error("taapi_io_price_retriever_skill not found. The market scanner depends on it.");
}

async function fetchBulkIndicators(
  symbol: string,
  indicators: Array<{ indicator: string; [key: string]: any }>,
  exchange: string,
  interval: string,
  assetType: string,
): Promise<Record<string, any>> {
  await loadTaapi();

  const result = await taapiExecute!({
    action: "bulk",
    symbol,
    exchange,
    interval,
    assetType,
    indicators: indicators.map((ind) => ({
      ...ind,
      id: ind.id || ind.indicator,
    })),
  });

  const parsed = JSON.parse(result);
  if (parsed.status !== "ok" || !parsed.results) {
    return { _error: parsed.error || "Bulk query failed" };
  }

  // Index by id
  const indexed: Record<string, any> = {};
  for (const entry of parsed.results) {
    const rawId = entry.id || entry.indicator || "";
    const matched = indicators.find((ind) => rawId.includes(ind.indicator) && (!ind.id || rawId === ind.id || rawId.includes(ind.id)));
    const shortId = matched?.id || matched?.indicator || rawId;
    indexed[shortId] = entry.result ? { status: "ok", ...entry.result } : { status: "error", error: entry.errors?.[0] };
  }

  return indexed;
}

// Fallback: fetch indicators individually if bulk fails
async function fetchIndividualIndicators(
  symbol: string,
  indicators: Array<{ indicator: string; [key: string]: any }>,
  exchange: string,
  interval: string,
  assetType: string,
): Promise<Record<string, any>> {
  await loadTaapi();
  const results: Record<string, any> = {};

  for (const ind of indicators) {
    const id = ind.id || ind.indicator;
    try {
      const result = await taapiExecute!({
        action: "indicator",
        symbol,
        exchange,
        interval,
        assetType,
        indicator: ind.indicator,
        ...(ind.period && { period: ind.period }),
        ...(ind.backtrack !== undefined && { backtrack: ind.backtrack }),
      });
      const parsed = JSON.parse(result);
      results[id] = parsed.status === "ok" ? { status: "ok", ...parsed } : { status: "error", error: parsed.error };
    } catch (err: any) {
      results[id] = { status: "error", error: err.message };
    }
  }

  return results;
}

async function fetchSymbolData(
  symbol: string,
  indicators: Array<{ indicator: string; [key: string]: any }>,
  exchange: string,
  interval: string,
  assetType: string,
): Promise<Record<string, any>> {
  // Try bulk first (1 API call), fall back to individual
  try {
    if (indicators.length <= 20) {
      return await fetchBulkIndicators(symbol, indicators, exchange, interval, assetType);
    }
  } catch { /* fall through */ }

  return await fetchIndividualIndicators(symbol, indicators, exchange, interval, assetType);
}

/* ────────────────────── watchlist persistence ────────────────────── */

interface WatchlistStore {
  watchlists: Record<string, string[]>;
}

async function loadWatchlists(): Promise<WatchlistStore> {
  try {
    const raw = await fs.readFile(WATCHLIST_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return { watchlists: { default: [...DEFAULT_CRYPTO_WATCHLIST] } };
  }
}

async function saveWatchlists(store: WatchlistStore): Promise<void> {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  const tmp = path.join(CONFIG_DIR, `.wl_tmp_${crypto.randomBytes(8).toString("hex")}`);
  try {
    await fs.writeFile(tmp, JSON.stringify(store, null, 2), "utf8");
    await fs.rename(tmp, WATCHLIST_PATH);
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
}

/* ────────────────────── custom filter parser ────────────────────── */

interface FilterCondition {
  indicator: string;
  field: string;
  op: string;
  value: number;
}

function parseCustomStrategy(expr: string): { conditions: FilterCondition[]; indicators: Array<{ indicator: string; [key: string]: any }> } {
  // Parse: "rsi < 30 AND macd_hist > 0 AND adx > 25"
  const parts = expr.split(/\s+AND\s+/i);
  const conditions: FilterCondition[] = [];
  const indicatorSet = new Set<string>();

  for (const part of parts) {
    const match = part.trim().match(/^(\w+?)(?:_(\w+))?\s*(>|<|>=|<=|==|!=)\s*(-?\d+(?:\.\d+)?)$/);
    if (!match) throw new Error(`Invalid filter condition: "${part.trim()}". Use format: indicator_field op value (e.g. rsi < 30, macd_hist > 0)`);

    const [, indicator, field, op, rawVal] = match;
    conditions.push({
      indicator: indicator.toLowerCase(),
      field: field || "value",
      op,
      value: parseFloat(rawVal),
    });
    indicatorSet.add(indicator.toLowerCase());
  }

  // Map known short names to TAAPI indicator names
  const INDICATOR_MAP: Record<string, string> = {
    macd: "macd", rsi: "rsi", adx: "adx", atr: "atr", bbw: "bbw",
    obv: "obv", mfi: "mfi", cci: "cci", stochrsi: "stochrsi",
    volume: "volume", ema: "ema", sma: "sma", bbands: "bbands",
  };

  const indicators = [...indicatorSet].map((name) => ({
    indicator: INDICATOR_MAP[name] || name,
    id: name,
  }));

  return { conditions, indicators };
}

function evaluateCustomFilter(data: Record<string, any>, conditions: FilterCondition[]): boolean {
  for (const cond of conditions) {
    const entry = data[cond.indicator];
    if (!entry || entry.status === "error") return false;

    // Try field name directly, then "value" + field as suffix (e.g. "valueMACDHist" for "hist")
    let actual = entry[cond.field];
    if (actual === undefined) {
      // Try camelCase patterns
      const capitalized = cond.field.charAt(0).toUpperCase() + cond.field.slice(1);
      actual = entry[`value${capitalized}`] ?? entry[`value${cond.indicator.toUpperCase()}${capitalized}`];
    }
    if (actual === undefined) actual = entry.value;
    if (typeof actual !== "number") return false;

    switch (cond.op) {
      case ">": if (!(actual > cond.value)) return false; break;
      case "<": if (!(actual < cond.value)) return false; break;
      case ">=": if (!(actual >= cond.value)) return false; break;
      case "<=": if (!(actual <= cond.value)) return false; break;
      case "==": if (actual !== cond.value) return false; break;
      case "!=": if (actual === cond.value) return false; break;
    }
  }
  return true;
}

/* ────────────────────── execute ────────────────────── */

export async function execute(args: any): Promise<string> {
  const start = Date.now();
  const { action } = args;

  try {
    switch (action) {
      case "scan":
        return await handleScan(args, start);
      case "watchlist":
        return await handleViewWatchlist(args, start);
      case "add_watchlist":
        return await handleAddWatchlist(args, start);
      case "remove_watchlist":
        return await handleRemoveWatchlist(args, start);
      case "presets":
        return handlePresets(start);
      default:
        throw new Error(`Unknown action: ${action}. Use: scan, watchlist, add_watchlist, remove_watchlist, presets`);
    }
  } catch (err: any) {
    return JSON.stringify({ status: "error", action, error: err.message, elapsedMs: Date.now() - start });
  }
}

async function handleScan(args: any, start: number): Promise<string> {
  const exchange = (args.exchange || "binance").toLowerCase();
  const interval = (args.interval || "1d").toLowerCase();
  const assetType = (args.assetType || args.type || "crypto").toLowerCase();
  const maxResults = Math.min(Math.max(1, Number(args.maxResults) || 20), 50);
  const strategyName = (args.strategy || "full_analysis").toLowerCase().trim();

  // Resolve symbols
  let symbols: string[];
  if (args.symbols && Array.isArray(args.symbols) && args.symbols.length > 0) {
    symbols = args.symbols.map((s: string) => s.toUpperCase().trim());
  } else {
    const store = await loadWatchlists();
    const wlName = args.watchlistName || "default";
    symbols = store.watchlists[wlName] || DEFAULT_CRYPTO_WATCHLIST;
  }

  if (symbols.length > MAX_SCAN_SYMBOLS) {
    symbols = symbols.slice(0, MAX_SCAN_SYMBOLS);
  }

  // Resolve strategy
  let strategyDef: StrategyDef | null = BUILT_IN_STRATEGIES[strategyName] || null;
  let customConditions: FilterCondition[] | null = null;
  let indicators: Array<{ indicator: string; [key: string]: any }>;

  if (strategyDef) {
    indicators = strategyDef.indicators;
  } else {
    // Try parsing as custom expression
    try {
      const parsed = parseCustomStrategy(args.strategy);
      customConditions = parsed.conditions;
      indicators = parsed.indicators;
    } catch (err: any) {
      return JSON.stringify({
        status: "error",
        action: "scan",
        error: `Unknown strategy "${args.strategy}". Use a preset name or custom expression (e.g. "rsi < 30 AND adx > 25"). Available presets: ${Object.keys(BUILT_IN_STRATEGIES).join(", ")}`,
        elapsedMs: Date.now() - start,
      });
    }
  }

  // Scan each symbol
  const results: Array<{
    symbol: string;
    match: boolean;
    score: number;
    data: Record<string, any>;
    error?: string;
  }> = [];

  const scanStart = Date.now();
  let scanned = 0;
  let errors = 0;

  for (const symbol of symbols) {
    if (Date.now() - scanStart > SCAN_TIMEOUT) break;

    try {
      const data = await fetchSymbolData(symbol, indicators, exchange, interval, assetType);

      if (data._error) {
        results.push({ symbol, match: false, score: 0, data: {}, error: data._error });
        errors++;
        continue;
      }

      let match: boolean;
      let score: number;

      if (strategyDef) {
        match = strategyDef.filter(data);
        score = match ? strategyDef.score(data) : 0;
      } else if (customConditions) {
        match = evaluateCustomFilter(data, customConditions);
        score = match ? 1 : 0;
      } else {
        match = true;
        score = 0;
      }

      // Flatten data for output
      const flatData: Record<string, any> = {};
      for (const [id, entry] of Object.entries(data)) {
        if (entry && entry.status !== "error") {
          const { status, ...rest } = entry as any;
          flatData[id] = rest;
        }
      }

      results.push({ symbol, match, score, data: flatData });
      scanned++;
    } catch (err: any) {
      results.push({ symbol, match: false, score: 0, data: {}, error: err.message });
      errors++;
    }
  }

  // Filter to matches and sort
  let matches = results.filter((r) => r.match);
  const sortBy = args.sortBy;
  const sortOrder = args.sortOrder === "asc" ? 1 : -1;

  if (sortBy) {
    matches.sort((a, b) => {
      const va = a.data[sortBy]?.value ?? a.data[sortBy] ?? 0;
      const vb = b.data[sortBy]?.value ?? b.data[sortBy] ?? 0;
      return (typeof va === "number" && typeof vb === "number" ? va - vb : 0) * sortOrder;
    });
  } else {
    matches.sort((a, b) => (b.score - a.score));
  }

  matches = matches.slice(0, maxResults);

  return JSON.stringify({
    status: "ok",
    action: "scan",
    strategy: strategyDef?.name || args.strategy,
    description: strategyDef?.description || "Custom filter",
    exchange,
    interval,
    scanned,
    errors,
    matchCount: matches.length,
    totalSymbols: symbols.length,
    matches: matches.map((m) => ({
      symbol: m.symbol,
      score: Math.round(m.score * 100) / 100,
      indicators: m.data,
    })),
    elapsedMs: Date.now() - start,
  });
}

async function handleViewWatchlist(args: any, start: number): Promise<string> {
  const store = await loadWatchlists();
  const name = args.watchlistName || "default";
  const symbols = store.watchlists[name];
  if (!symbols) {
    return JSON.stringify({
      status: "ok",
      action: "watchlist",
      availableWatchlists: Object.keys(store.watchlists),
      error: `Watchlist "${name}" not found`,
      elapsedMs: Date.now() - start,
    });
  }
  return JSON.stringify({
    status: "ok",
    action: "watchlist",
    name,
    symbols,
    count: symbols.length,
    availableWatchlists: Object.keys(store.watchlists),
    elapsedMs: Date.now() - start,
  });
}

async function handleAddWatchlist(args: any, start: number): Promise<string> {
  const symbols = args.symbols;
  if (!Array.isArray(symbols) || symbols.length === 0) {
    throw new Error("symbols array is required for add_watchlist");
  }
  const name = args.watchlistName || "default";
  const store = await loadWatchlists();
  if (!store.watchlists[name]) store.watchlists[name] = [];

  const added: string[] = [];
  for (const s of symbols) {
    const upper = s.toUpperCase().trim();
    if (upper && !store.watchlists[name].includes(upper)) {
      store.watchlists[name].push(upper);
      added.push(upper);
    }
  }

  if (store.watchlists[name].length > 100) {
    throw new Error(`Watchlist "${name}" would exceed 100 symbols. Remove some first.`);
  }

  await saveWatchlists(store);
  return JSON.stringify({
    status: "ok",
    action: "add_watchlist",
    name,
    added,
    totalCount: store.watchlists[name].length,
    elapsedMs: Date.now() - start,
  });
}

async function handleRemoveWatchlist(args: any, start: number): Promise<string> {
  const symbols = args.symbols;
  if (!Array.isArray(symbols) || symbols.length === 0) {
    throw new Error("symbols array is required for remove_watchlist");
  }
  const name = args.watchlistName || "default";
  const store = await loadWatchlists();
  if (!store.watchlists[name]) throw new Error(`Watchlist "${name}" not found`);

  const removeSet = new Set(symbols.map((s: string) => s.toUpperCase().trim()));
  const before = store.watchlists[name].length;
  store.watchlists[name] = store.watchlists[name].filter((s) => !removeSet.has(s));
  const removed = before - store.watchlists[name].length;

  await saveWatchlists(store);
  return JSON.stringify({
    status: "ok",
    action: "remove_watchlist",
    name,
    removed,
    totalCount: store.watchlists[name].length,
    elapsedMs: Date.now() - start,
  });
}

function handlePresets(start: number): string {
  const presets = Object.entries(BUILT_IN_STRATEGIES).map(([key, def]) => ({
    name: key,
    title: def.name,
    description: def.description,
    indicators: def.indicators.map((i) => i.indicator),
  }));

  return JSON.stringify({
    status: "ok",
    action: "presets",
    presets,
    customFormat: 'Custom expressions: "rsi < 30 AND macd_hist > 0 AND adx > 25". Supported operators: >, <, >=, <=, ==, !=. Join with AND.',
    elapsedMs: Date.now() - start,
  });
}
