import axios from "axios";
import { getSkillSecret } from "../../src/security/skillSecrets.js";

export const secrets = {
  TAAPI_API_KEY: { description: "API key from taapi.io", required: true },
};

export const parameters = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["price", "indicator", "candle", "bulk"],
      description: "Action: price (current price), indicator (technical indicator), candle (OHLCV data), bulk (multiple indicators in one request). Default: price.",
    },
    symbol: { type: "string", description: "Symbol (e.g., BTC/USDT for crypto or AAPL for stocks)." },
    assetType: { type: "string", enum: ["crypto", "stocks"], description: "The asset class. Default: crypto." },
    type: { type: "string", enum: ["crypto", "stocks"], description: "Alias for assetType." },
    exchange: { type: "string", description: "Exchange for crypto (e.g., binance, coinbase, kraken). Default: binance." },
    interval: { type: "string", description: "Time interval: 1m, 5m, 15m, 30m, 1h, 2h, 4h, 12h, 1d, 1w. Default: 1d." },

    // Indicator-specific
    indicator: { type: "string", description: "Indicator name for action=indicator (e.g. rsi, macd, ema, bbands, stochrsi, adx, atr, obv, vwap, supertrend)." },
    period: { type: "number", description: "Indicator period/length (e.g. 14 for RSI, 20 for SMA). Indicator-specific." },
    indicatorParams: { type: "object", description: "Additional indicator-specific params (e.g. { optInFastPeriod: 12, optInSlowPeriod: 26 } for MACD)." },
    chart: { type: "string", enum: ["candles", "heikinashi"], description: "Chart type for indicator calculation. Default: candles." },

    // Bulk-specific
    indicators: {
      type: "array",
      items: { type: "object" },
      description: "Array of indicator objects for bulk action. Each: { indicator: 'rsi', period?: 14, backtrack?: 0, id?: 'my_rsi', ... }",
    },

    // History / backtrack
    backtrack: { type: "number", description: "How many candles back from latest (max 50 per TAAPI limits)." },
    results: { type: "string", description: "Number of results (e.g., '10') or 'max'." },
    fromTimestamp: { type: "number", description: "UNIX start timestamp (seconds)." },
    toTimestamp: { type: "number", description: "UNIX end timestamp (seconds)." },
    fromDate: { type: "string", description: "Start date/time in ISO format (converted to UNIX timestamp)." },
    toDate: { type: "string", description: "End date/time in ISO format (converted to UNIX timestamp)." },
    addResultTimestamp: { type: "boolean", description: "Include timestamp with each returned point." },
  },
  required: ["symbol"],
};

/* ────────────────────── constants ────────────────────── */

const BASE_URL = "https://api.taapi.io";
const VALID_INTERVALS = new Set(["1m", "5m", "15m", "30m", "1h", "2h", "4h", "12h", "1d", "1w"]);
const VALID_EXCHANGES = new Set([
  "binance", "binancefutures", "bitstamp", "coinbase", "kraken",
  "kucoin", "bybit", "okx", "bitfinex", "gemini", "gateio", "whitebit",
]);
const SYMBOL_REGEX = /^[A-Z0-9]{1,15}(\/[A-Z0-9]{1,15})?$/;
const MAX_RETRIES = 2;
const MAX_POINTS = 500;
const MAX_BULK_INDICATORS = 20;
const MAX_BACKTRACK = 50;

// Known indicators (not exhaustive — TAAPI has 200+, but these are the most common for validation hints)
const COMMON_INDICATORS = new Set([
  // Momentum
  "rsi", "macd", "stochrsi", "stoch", "stochf", "cci", "mfi", "adx", "adxr", "willr",
  "mom", "roc", "ao", "apo", "ppo", "trix", "ultosc", "aroon", "aroonosc", "bop",
  "cmo", "minus_di", "minus_dm", "plus_di", "plus_dm", "rvgi", "supertrend", "tdsequential",
  "squeeze", "stc", "wad",
  // Overlap / Moving Averages
  "ema", "sma", "dema", "tema", "trima", "kama", "mama", "t3", "vwma", "smma",
  "zlema", "wilders", "midpoint", "midprice", "psar", "ichimoku", "vwap",
  "accbands", "bbands", "keltnerchannels", "donchianchannels", "fibonacciretracement",
  "kdj", "ht_trendline", "williamsalligator",
  // Volatility
  "atr", "natr", "bbw", "stddev", "volatility", "mass", "tr",
  // Volume
  "obv", "ad", "adosc", "cmf", "kvo", "nvi", "pvi", "volume", "volumesplit", "vosc",
  // Price / Candle
  "price", "candle", "candles", "avgprice", "medprice", "typprice", "wclprice",
  // Patterns
  "doji", "hammer", "engulfing", "morningstar", "eveningstar", "shootingstar",
  "hangingman", "harami", "spinningtop", "marubozu",
  // Support / Resistance
  "pivotpoints",
]);

/* ────────────────────── types ────────────────────── */

interface MappedError {
  category: string;
  message: string;
  retryable: boolean;
}

interface ParsedHistoryArgs {
  backtrack?: number;
  results?: number | "max";
  fromTimestamp?: number;
  toTimestamp?: number;
  addResultTimestamp?: boolean;
}

/* ────────────────────── helpers ────────────────────── */

function fail(error: string, errorCategory: string, start: number): string {
  return JSON.stringify({ status: "error", error, errorCategory, elapsedMs: Date.now() - start });
}

function normalizeSymbol(symbolRaw: string, assetType: string): string {
  const upper = symbolRaw.toUpperCase().trim();
  if (assetType !== "crypto" || upper.includes("/")) return upper;
  const quoteCandidates = ["USDT", "USDC", "BUSD", "USD", "BTC", "ETH", "EUR", "GBP", "JPY"];
  for (const quote of quoteCandidates) {
    if (upper.endsWith(quote) && upper.length > quote.length) {
      return `${upper.slice(0, -quote.length)}/${quote}`;
    }
  }
  return upper;
}

function parsePositiveInt(value: unknown, name: string): number {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num) || num < 0 || !Number.isInteger(num)) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return num;
}

function parseUnixTimestamp(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return parsePositiveInt(value, name);
}

function parseDateToUnix(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error(`${name} must be a string in ISO date format`);
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new Error(`${name} is not a valid date`);
  return Math.floor(ms / 1000);
}

function parseHistoryArgs(args: any): ParsedHistoryArgs {
  const out: ParsedHistoryArgs = {};
  const fromTs = parseUnixTimestamp(args.fromTimestamp, "fromTimestamp");
  const toTs = parseUnixTimestamp(args.toTimestamp, "toTimestamp");
  const fromDateTs = parseDateToUnix(args.fromDate, "fromDate");
  const toDateTs = parseDateToUnix(args.toDate, "toDate");

  if (fromTs !== undefined && fromDateTs !== undefined) throw new Error("Provide either fromTimestamp or fromDate, not both");
  if (toTs !== undefined && toDateTs !== undefined) throw new Error("Provide either toTimestamp or toDate, not both");

  out.fromTimestamp = fromTs ?? fromDateTs;
  out.toTimestamp = toTs ?? toDateTs;
  const hasDateRange = out.fromTimestamp !== undefined || out.toTimestamp !== undefined;

  if (out.fromTimestamp !== undefined && out.toTimestamp !== undefined && out.fromTimestamp > out.toTimestamp) {
    throw new Error("fromTimestamp must be <= toTimestamp");
  }

  if (args.backtrack !== undefined && args.backtrack !== null && args.backtrack !== "") {
    out.backtrack = parsePositiveInt(args.backtrack, "backtrack");
    if (out.backtrack > MAX_BACKTRACK) {
      throw new Error(`backtrack max is ${MAX_BACKTRACK} (TAAPI limit: max 20 calculations per request)`);
    }
  }

  if (args.results !== undefined && args.results !== null && args.results !== "") {
    const raw = String(args.results).trim().toLowerCase();
    if (raw === "max") out.results = "max";
    else out.results = parsePositiveInt(raw, "results");
  }

  if (hasDateRange && (out.backtrack !== undefined || out.results !== undefined)) {
    throw new Error("Use either from/to date range OR backtrack/results, not both");
  }

  if (typeof args.addResultTimestamp === "boolean") {
    out.addResultTimestamp = args.addResultTimestamp;
  } else if (out.backtrack !== undefined || out.results !== undefined || out.fromTimestamp !== undefined || out.toTimestamp !== undefined) {
    out.addResultTimestamp = true;
  }

  return out;
}

function normalizeValue(v: any): number | string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : String(v);
}

/* ────────────────────── error mapping ────────────────────── */

function mapError(error: any): MappedError {
  const status = error.response?.status;
  const apiError = error.response?.data?.error || error.response?.data?.errors || "";
  const errorStr = typeof apiError === "object" ? JSON.stringify(apiError) : String(apiError || error.message || "");

  if (status === 401 || /invalid.*key|unauthorized|api.?key/i.test(errorStr)) {
    return { category: "invalid_api_key", message: "Invalid TAAPI API key. Check TAAPI_API_KEY in Skill Secrets.", retryable: false };
  }
  if (status === 429 || /rate.?limit|too many|quota/i.test(errorStr)) {
    return { category: "rate_limited", message: "TAAPI rate limit exceeded. Try again shortly.", retryable: true };
  }
  if (/symbol|pair|not found|invalid.*symbol/i.test(errorStr)) {
    return { category: "bad_symbol", message: `Invalid symbol or pair. ${errorStr}`, retryable: false };
  }
  if (/interval/i.test(errorStr)) {
    return { category: "bad_interval", message: `Invalid interval. Use: ${[...VALID_INTERVALS].join(", ")}`, retryable: false };
  }
  if (/exchange/i.test(errorStr)) {
    return { category: "bad_exchange", message: `Invalid exchange. ${errorStr}`, retryable: false };
  }
  if (/indicator/i.test(errorStr)) {
    return { category: "bad_indicator", message: `Invalid indicator. ${errorStr}`, retryable: false };
  }
  if (/no candles were found|no candles|no data/i.test(errorStr)) {
    return { category: "no_data", message: "No candles found. Try interval=1d, remove results/max, or narrow the date range.", retryable: false };
  }
  if (status && status >= 500) {
    return { category: "server", message: `TAAPI server error (${status}).`, retryable: true };
  }
  if (["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"].includes(error.code)) {
    return { category: "network", message: `Network error: ${error.message}`, retryable: true };
  }
  return { category: "unknown", message: errorStr || "Unknown error", retryable: false };
}

/* ────────────────────── retry ────────────────────── */

async function withRetry<T>(fn: () => Promise<T>, maxRetries: number): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      const mapped = mapError(err);
      if (attempt < maxRetries && mapped.retryable) {
        const delay = Math.pow(2, attempt) * 1000 + Math.random() * 500;
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      const enriched = new Error(mapped.message) as Error & { category?: string };
      (enriched as any).category = mapped.category;
      throw enriched;
    }
  }
  throw new Error("Retry exhausted");
}

/* ────────────────────── validation ────────────────────── */

interface ValidatedBase {
  symbol: string;
  assetType: string;
  exchange: string;
  interval: string;
  apiKey: string;
}

function validateBase(args: any, start: number): ValidatedBase | string {
  const assetType = (args.assetType || args.type || "crypto").toLowerCase().trim();
  const symbol = normalizeSymbol(String(args.symbol || ""), assetType);
  const exchange = (args.exchange || "binance").toLowerCase().trim();
  const interval = (args.interval || "1d").toLowerCase().trim();

  if (!symbol) return fail("symbol is required", "validation", start);
  if (!["crypto", "stocks"].includes(assetType)) return fail(`Invalid assetType: "${assetType}".`, "validation", start);
  if (!SYMBOL_REGEX.test(symbol)) return fail(`Invalid symbol: "${symbol}". Use BTC/USDT or AAPL.`, "validation", start);
  if (!VALID_INTERVALS.has(interval)) return fail(`Invalid interval: "${interval}". Use: ${[...VALID_INTERVALS].join(", ")}`, "validation", start);
  if (assetType === "crypto" && !VALID_EXCHANGES.has(exchange)) return fail(`Invalid exchange: "${exchange}". Use: ${[...VALID_EXCHANGES].join(", ")}`, "validation", start);

  const apiKey = getSkillSecret("taapi_io_price_retriever_skill", "TAAPI_API_KEY");
  if (!apiKey) return fail("TAAPI_API_KEY not configured. Add it in Setup > Skill Secrets.", "invalid_api_key", start);

  return { symbol, assetType, exchange, interval, apiKey };
}

function buildBaseParams(base: ValidatedBase): Record<string, string | number | boolean> {
  const params: Record<string, string | number | boolean> = {
    secret: base.apiKey,
    symbol: base.symbol,
    interval: base.interval,
  };
  if (base.assetType === "stocks") params.type = "stocks";
  else params.exchange = base.exchange;
  return params;
}

function applyHistoryParams(params: Record<string, string | number | boolean>, history: ParsedHistoryArgs): void {
  if (history.backtrack !== undefined) params.backtrack = history.backtrack;
  if (history.results !== undefined) params.results = history.results;
  if (history.fromTimestamp !== undefined) params.fromTimestamp = history.fromTimestamp;
  if (history.toTimestamp !== undefined) params.toTimestamp = history.toTimestamp;
  if (history.addResultTimestamp !== undefined) params.addResultTimestamp = history.addResultTimestamp;
}

/* ────────────────────── response builders ────────────────────── */

function buildSeriesResponse(data: any, base: ValidatedBase, history: ParsedHistoryArgs, action: string, start: number, extra?: any): string {
  const rawValue = data?.value;
  const rawTimestamp = data?.timestamp;

  if (Array.isArray(rawValue) || Array.isArray(rawTimestamp)) {
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    const timestamps = Array.isArray(rawTimestamp) ? rawTimestamp : [];
    const points = values.map((v: any, i: number) => ({
      value: normalizeValue(v),
      timestamp: timestamps[i] ?? null,
    }));
    const truncated = points.length > MAX_POINTS;
    const trimmed = truncated ? points.slice(points.length - MAX_POINTS) : points;
    const last = trimmed[trimmed.length - 1];

    return JSON.stringify({
      status: "ok",
      action,
      mode: "series",
      asset: base.symbol,
      type: base.assetType,
      exchange: base.assetType === "crypto" ? base.exchange : undefined,
      interval: base.interval,
      ...extra,
      points: trimmed,
      count: trimmed.length,
      truncated,
      latest: last?.value ?? null,
      latestTimestamp: last?.timestamp ?? null,
      requestedAt: new Date().toISOString(),
      elapsedMs: Date.now() - start,
    });
  }

  // Single value response
  return JSON.stringify({
    status: "ok",
    action,
    mode: "single",
    asset: base.symbol,
    type: base.assetType,
    exchange: base.assetType === "crypto" ? base.exchange : undefined,
    interval: base.interval,
    ...extra,
    ...flattenIndicatorResult(data),
    requestedAt: new Date().toISOString(),
    elapsedMs: Date.now() - start,
  });
}

/** Flatten indicator-specific result fields (e.g. valueMACD, valueMACDSignal → macd, macdSignal) */
function flattenIndicatorResult(data: any): Record<string, any> {
  if (!data || typeof data !== "object") return { value: data };
  const out: Record<string, any> = {};
  for (const [key, val] of Object.entries(data)) {
    if (key === "error") continue;
    out[key] = normalizeValue(val);
  }
  return out;
}

/* ────────────────────── actions ────────────────────── */

async function handlePrice(args: any, base: ValidatedBase, start: number): Promise<string> {
  let history: ParsedHistoryArgs;
  try { history = parseHistoryArgs(args); } catch (err: any) { return fail(err.message, "validation", start); }

  const params = buildBaseParams(base);
  applyHistoryParams(params, history);

  const response = await withRetry(() => axios.get(`${BASE_URL}/price`, { params, timeout: 10000 }), MAX_RETRIES);
  if (response.data?.error) throw new Error(String(response.data.error));

  return buildSeriesResponse(response.data, base, history, "price", start);
}

async function handleIndicator(args: any, base: ValidatedBase, start: number): Promise<string> {
  const indicator = (args.indicator || "").toLowerCase().trim();
  if (!indicator) return fail("indicator is required for action=indicator. Examples: rsi, macd, ema, bbands, atr", "validation", start);

  // Warn (don't block) if indicator is unknown — TAAPI has 200+ and we only track common ones
  const indicatorWarning = !COMMON_INDICATORS.has(indicator) ? `Note: "${indicator}" is not in the common indicators list — it may still work.` : undefined;

  let history: ParsedHistoryArgs;
  try { history = parseHistoryArgs(args); } catch (err: any) { return fail(err.message, "validation", start); }

  const params = buildBaseParams(base);
  applyHistoryParams(params, history);

  // Indicator-specific params
  if (args.period !== undefined) params.optInTimePeriod = args.period;
  if (args.chart) params.chart = args.chart;

  // Pass through any additional indicator params
  if (args.indicatorParams && typeof args.indicatorParams === "object") {
    for (const [k, v] of Object.entries(args.indicatorParams)) {
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
        params[k] = v;
      }
    }
  }

  const response = await withRetry(() => axios.get(`${BASE_URL}/${indicator}`, { params, timeout: 10000 }), MAX_RETRIES);
  if (response.data?.error) throw new Error(String(response.data.error));

  return buildSeriesResponse(response.data, base, history, "indicator", start, {
    indicator,
    ...(indicatorWarning && { warning: indicatorWarning }),
  });
}

async function handleCandle(args: any, base: ValidatedBase, start: number): Promise<string> {
  let historyArgs: ParsedHistoryArgs;
  try { historyArgs = parseHistoryArgs(args); } catch (err: any) { return fail(err.message, "validation", start); }

  const params = buildBaseParams(base);
  applyHistoryParams(params, historyArgs);

  const response = await withRetry(() => axios.get(`${BASE_URL}/candle`, { params, timeout: 10000 }), MAX_RETRIES);
  if (response.data?.error) throw new Error(String(response.data.error));

  const data = response.data;

  // Candle returns OHLCV fields directly
  return JSON.stringify({
    status: "ok",
    action: "candle",
    mode: "single",
    asset: base.symbol,
    type: base.assetType,
    exchange: base.assetType === "crypto" ? base.exchange : undefined,
    interval: base.interval,
    open: normalizeValue(data.open),
    high: normalizeValue(data.high),
    low: normalizeValue(data.low),
    close: normalizeValue(data.close),
    volume: normalizeValue(data.volume),
    timestamp: data.timestamp ?? null,
    timestampHuman: data.timestampHuman ?? null,
    requestedAt: new Date().toISOString(),
    elapsedMs: Date.now() - start,
  });
}

async function handleBulk(args: any, base: ValidatedBase, start: number): Promise<string> {
  const indicators = args.indicators;
  if (!Array.isArray(indicators) || indicators.length === 0) {
    return fail("indicators array is required for action=bulk. Each: { indicator: 'rsi', period?: 14, backtrack?: 0 }", "validation", start);
  }
  if (indicators.length > MAX_BULK_INDICATORS) {
    return fail(`Too many indicators: ${indicators.length} (max ${MAX_BULK_INDICATORS} per TAAPI limits).`, "validation", start);
  }

  // Count total calculations (each indicator × backtracks)
  let totalCalcs = 0;
  const builtIndicators: any[] = [];
  for (const ind of indicators) {
    if (!ind.indicator || typeof ind.indicator !== "string") {
      return fail("Each indicator must have an 'indicator' field (e.g. 'rsi', 'macd').", "validation", start);
    }
    const bt = ind.backtrack || 0;
    totalCalcs += Math.max(1, bt);
    const built: any = { indicator: ind.indicator.toLowerCase() };
    if (ind.id) built.id = ind.id;
    if (ind.backtrack !== undefined) built.backtrack = ind.backtrack;
    if (ind.period !== undefined) built.optInTimePeriod = ind.period;
    if (ind.results !== undefined) built.results = ind.results;
    if (ind.addResultTimestamp !== undefined) built.addResultTimestamp = ind.addResultTimestamp;
    if (ind.chart) built.chart = ind.chart;
    // Pass through extra params
    if (ind.params && typeof ind.params === "object") {
      Object.assign(built, ind.params);
    }
    builtIndicators.push(built);
  }

  if (totalCalcs > 20) {
    return fail(`Total calculations (${totalCalcs}) exceeds TAAPI limit of 20 per request. Reduce backtracks or number of indicators.`, "validation", start);
  }

  const body: any = {
    secret: base.apiKey,
    construct: {
      exchange: base.assetType === "stocks" ? undefined : base.exchange,
      symbol: base.symbol,
      interval: base.interval,
      ...(base.assetType === "stocks" && { type: "stocks" }),
      indicators: builtIndicators,
    },
  };

  const response = await withRetry(
    () => axios.post(`${BASE_URL}/bulk`, body, { timeout: 15000, headers: { "Content-Type": "application/json" } }),
    MAX_RETRIES,
  );

  if (response.data?.error) throw new Error(String(response.data.error));

  const results = (response.data?.data || []).map((entry: any) => ({
    id: entry.id,
    indicator: entry.id?.split("_").slice(-2, -1)[0] || entry.indicator,
    result: entry.result ? flattenIndicatorResult(entry.result) : null,
    errors: entry.errors?.length > 0 ? entry.errors : undefined,
  }));

  return JSON.stringify({
    status: "ok",
    action: "bulk",
    asset: base.symbol,
    type: base.assetType,
    exchange: base.assetType === "crypto" ? base.exchange : undefined,
    interval: base.interval,
    indicatorCount: results.length,
    results,
    requestedAt: new Date().toISOString(),
    elapsedMs: Date.now() - start,
  });
}

/* ────────────────────── main execute ────────────────────── */

export async function execute(args: any): Promise<string> {
  const start = Date.now();
  const action = (args.action || "price").toLowerCase().trim();

  try {
    const baseResult = validateBase(args, start);
    if (typeof baseResult === "string") return baseResult; // validation error
    const base = baseResult;

    switch (action) {
      case "price":
        return await handlePrice(args, base, start);
      case "indicator":
        return await handleIndicator(args, base, start);
      case "candle":
        return await handleCandle(args, base, start);
      case "bulk":
        return await handleBulk(args, base, start);
      default:
        return fail(`Unknown action: "${action}". Use: price, indicator, candle, bulk`, "validation", start);
    }
  } catch (error: any) {
    const category = (error as any).category || "unknown";
    return fail(error.message || "Unknown error", category, start);
  }
}
