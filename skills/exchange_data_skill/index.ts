import axios from "axios";

export const parameters = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: [
        "markets", "ticker", "orderbook", "trades", "trending",
        "global", "categories", "exchanges", "fear_greed",
      ],
      description:
        "Action: markets (top coins by market cap), ticker (price/volume/change for a coin), orderbook (bid/ask depth), trades (OHLC candle data), trending (trending coins), global (global market stats), categories (sector performance), exchanges (exchange rankings), fear_greed (Fear & Greed Index).",
    },
    // Common
    coinId: { type: "string", description: "CoinGecko coin ID (e.g. 'bitcoin', 'ethereum', 'solana'). Use for ticker, orderbook, trades." },
    symbol: { type: "string", description: "Ticker symbol (e.g. 'BTC', 'ETH'). Auto-resolved to coinId if coinId not provided." },
    currency: { type: "string", description: "Quote currency for prices (default: 'usd')" },

    // Markets
    category: { type: "string", description: "Filter markets by category (e.g. 'decentralized-finance-defi', 'layer-1')" },
    perPage: { type: "number", description: "Results per page for markets/exchanges (default: 20, max: 100)" },
    page: { type: "number", description: "Page number (default: 1)" },
    order: {
      type: "string",
      enum: ["market_cap_desc", "market_cap_asc", "volume_desc", "volume_asc"],
      description: "Sort order for markets (default: market_cap_desc)",
    },

    // Orderbook
    depth: { type: "number", description: "Orderbook depth - number of ticker pairs to return (default: 10, max: 50)" },
    exchange: { type: "string", description: "Exchange for orderbook/trades (e.g. 'binance', 'coinbase')" },

    // Trades (OHLC)
    days: { type: "number", description: "Number of days for OHLC data (1, 7, 14, 30, 90, 180, 365, max). Default: 7" },

    // Fear & Greed
    limit: { type: "number", description: "Number of historical Fear & Greed entries (default: 10, max: 30)" },
  },
  required: ["action"],
};

/* ------------------------------------------------------------------ */
/*  Constants                                                         */
/* ------------------------------------------------------------------ */

const CG_BASE = "https://api.coingecko.com/api/v3";
const MAX_RETRIES = 2;
const TIMEOUT = 10_000;

// Common symbol -> coinId mapping (saves an API call)
const SYMBOL_MAP: Record<string, string> = {
  BTC: "bitcoin", ETH: "ethereum", SOL: "solana", BNB: "binancecoin",
  XRP: "ripple", ADA: "cardano", AVAX: "avalanche-2", DOGE: "dogecoin",
  DOT: "polkadot", MATIC: "matic-network", LINK: "chainlink", UNI: "uniswap",
  ATOM: "cosmos", LTC: "litecoin", NEAR: "near", APT: "aptos",
  OP: "optimism", ARB: "arbitrum", FIL: "filecoin", INJ: "injective-protocol",
  SUI: "sui", SEI: "sei-network", TIA: "celestia", PEPE: "pepe",
  WIF: "dogwifcoin", BONK: "bonk", SHIB: "shiba-inu", FET: "fetch-ai",
  RNDR: "render-token", GRT: "the-graph", AAVE: "aave", MKR: "maker",
  CRV: "curve-dao-token", ALGO: "algorand", ICP: "internet-computer",
  VET: "vechain", HBAR: "hedera-hashgraph", FTM: "fantom", MANA: "decentraland",
  SAND: "the-sandbox", AXS: "axie-infinity", RUNE: "thorchain",
  STX: "blockstack", IMX: "immutable-x", PENDLE: "pendle", JUP: "jupiter-exchange-solana",
};

/* Cached /coins/list for dynamic symbol resolution */
let coinListCache: Array<{ id: string; symbol: string }> | null = null;
let coinListCacheTs = 0;
const COIN_LIST_TTL = 3_600_000; // 1 hour

/* ------------------------------------------------------------------ */
/*  TTL cache                                                         */
/* ------------------------------------------------------------------ */

interface CacheEntry { data: any; ts: number; }
const cache = new Map<string, CacheEntry>();
const TTL: Record<string, number> = {
  global: 120_000,      // 2 min
  trending: 300_000,    // 5 min
  categories: 300_000,  // 5 min
  fng: 600_000,         // 10 min
};

function getCached(key: string): any | null {
  const entry = cache.get(key);
  if (!entry) return null;
  const ttl = TTL[key] ?? 120_000;
  if (Date.now() - entry.ts > ttl) { cache.delete(key); return null; }
  return entry.data;
}

function setCache(key: string, data: any): void {
  cache.set(key, { data, ts: Date.now() });
}

async function cachedFetch(key: string, path: string, params?: Record<string, any>): Promise<any> {
  const hit = getCached(key);
  if (hit !== null) return hit;
  const data = await cgGet(path, params);
  setCache(key, data);
  return data;
}

async function cachedAxios(key: string, url: string): Promise<any> {
  const hit = getCached(key);
  if (hit !== null) return hit;
  const resp = await axios.get(url, { timeout: TIMEOUT });
  setCache(key, resp.data);
  return resp.data;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

type ErrorCategory = "validation" | "not_found" | "rate_limited" | "network" | "unknown";

function mapError(error: any): { category: ErrorCategory; message: string; retryable: boolean } {
  const status = error.response?.status;
  if (status === 429) return { category: "rate_limited", message: "CoinGecko rate limit. Try again in 30-60s.", retryable: true };
  if (status === 404) return { category: "not_found", message: "Coin or endpoint not found. Check coinId.", retryable: false };
  if (status === 400 || status === 422) return { category: "validation", message: `Invalid request (${status}): ${error.response?.data?.error || error.message}`, retryable: false };
  if (status && status >= 500) return { category: "network", message: `CoinGecko server error (${status}).`, retryable: true };
  if (["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"].includes(error.code)) {
    return { category: "network", message: `Network error: ${error.message}`, retryable: true };
  }
  return { category: "unknown", message: error.message || "Unknown error", retryable: false };
}

function fail(error: string, category: ErrorCategory, start: number): string {
  return JSON.stringify({ status: "error", error, errorCategory: category, elapsedMs: Date.now() - start });
}

async function resolveCoinId(args: any): Promise<string> {
  if (args.coinId) return args.coinId.toLowerCase().trim();
  if (args.symbol) {
    const upper = args.symbol.toUpperCase().trim().replace("/USDT", "").replace("/USD", "");
    // Static map first
    if (SYMBOL_MAP[upper]) return SYMBOL_MAP[upper];
    // Dynamic fallback via /coins/list
    const list = await getCoinList();
    const match = list.find((c) => c.symbol === upper.toLowerCase());
    if (match) return match.id;
    // Last resort: lowercase symbol
    return upper.toLowerCase();
  }
  throw Object.assign(new Error("coinId or symbol is required"), { category: "validation" as ErrorCategory });
}

async function getCoinList(): Promise<Array<{ id: string; symbol: string }>> {
  if (coinListCache && Date.now() - coinListCacheTs < COIN_LIST_TTL) return coinListCache;
  try {
    const data = await cgGet("/coins/list", { include_platform: false });
    coinListCache = (data || []).map((c: any) => ({ id: c.id, symbol: c.symbol }));
    coinListCacheTs = Date.now();
    return coinListCache!;
  } catch {
    return coinListCache || [];
  }
}

async function cgGet(path: string, params?: Record<string, any>): Promise<any> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const resp = await axios.get(`${CG_BASE}${path}`, { params, timeout: TIMEOUT });
      return resp.data;
    } catch (err: any) {
      const mapped = mapError(err);
      if (attempt < MAX_RETRIES && mapped.retryable) {
        await new Promise((resolve) => setTimeout(resolve, Math.pow(2, attempt) * 1500 + Math.random() * 500));
        continue;
      }
      const enriched = new Error(mapped.message) as any;
      enriched.category = mapped.category;
      throw enriched;
    }
  }
}

/** Round number safely -- null/undefined stay null, 0 stays 0 */
function r(n: number | null | undefined, dec = 2): number | null {
  if (n === null || n === undefined) return null;
  return Math.round(n * Math.pow(10, dec)) / Math.pow(10, dec);
}

/* ------------------------------------------------------------------ */
/*  Execute                                                           */
/* ------------------------------------------------------------------ */

export async function execute(args: any): Promise<string> {
  const start = Date.now();
  const { action } = args;

  try {
    switch (action) {
      case "markets": return await handleMarkets(args, start);
      case "ticker": return await handleTicker(args, start);
      case "orderbook": return await handleOrderbook(args, start);
      case "trades": return await handleTrades(args, start);
      case "trending": return await handleTrending(start);
      case "global": return await handleGlobal(start);
      case "categories": return await handleCategories(start);
      case "exchanges": return await handleExchanges(args, start);
      case "fear_greed": return await handleFearGreed(args, start);
      default:
        throw Object.assign(
          new Error(`Unknown action: ${action}. Use: markets, ticker, orderbook, trades, trending, global, categories, exchanges, fear_greed`),
          { category: "validation" as ErrorCategory },
        );
    }
  } catch (err: any) {
    return fail(err.message, err.category || mapError(err).category, start);
  }
}

/* ------------------------------------------------------------------ */
/*  markets                                                           */
/* ------------------------------------------------------------------ */

async function handleMarkets(args: any, start: number): Promise<string> {
  const currency = (args.currency || "usd").toLowerCase();
  const perPage = Math.min(Math.max(1, Number(args.perPage) || 20), 100);
  const page = Math.max(1, Number(args.page) || 1);
  const order = args.order || "market_cap_desc";

  const params: any = {
    vs_currency: currency,
    order,
    per_page: perPage,
    page,
    sparkline: false,
    price_change_percentage: "1h,24h,7d",
  };
  if (args.category) params.category = args.category;

  const data = await cgGet("/coins/markets", params);

  const coins = data.map((c: any) => ({
    id: c.id,
    symbol: c.symbol?.toUpperCase(),
    name: c.name,
    rank: c.market_cap_rank ?? null,
    price: c.current_price ?? null,
    marketCap: c.market_cap ?? null,
    volume24h: c.total_volume ?? null,
    change1h: r(c.price_change_percentage_1h_in_currency ?? null),
    change24h: r(c.price_change_percentage_24h ?? null),
    change7d: r(c.price_change_percentage_7d_in_currency ?? null),
    high24h: c.high_24h ?? null,
    low24h: c.low_24h ?? null,
    ath: c.ath ?? null,
    athChangePercent: r(c.ath_change_percentage ?? null),
    circulatingSupply: c.circulating_supply ?? null,
    totalSupply: c.total_supply ?? null,
  }));

  return JSON.stringify({ status: "ok", action: "markets", currency, count: coins.length, page, coins, elapsedMs: Date.now() - start });
}

/* ------------------------------------------------------------------ */
/*  ticker                                                            */
/* ------------------------------------------------------------------ */

async function handleTicker(args: any, start: number): Promise<string> {
  const coinId = await resolveCoinId(args);
  const currency = (args.currency || "usd").toLowerCase();

  const data = await cgGet(`/coins/${coinId}`, {
    localization: false,
    tickers: true,
    market_data: true,
    community_data: false,
    developer_data: false,
  });

  const md = data.market_data;
  const tickers = (data.tickers || []).slice(0, 10).map((t: any) => ({
    exchange: t.market?.name,
    pair: t.base + "/" + t.target,
    price: t.last ?? null,
    volume: t.volume ?? null,
    spread: r(t.bid_ask_spread_percentage ?? null, 4),
    trustScore: t.trust_score ?? null,
  }));

  return JSON.stringify({
    status: "ok",
    action: "ticker",
    id: data.id,
    symbol: data.symbol?.toUpperCase(),
    name: data.name,
    rank: data.market_cap_rank ?? null,
    price: md?.current_price?.[currency] ?? null,
    marketCap: md?.market_cap?.[currency] ?? null,
    volume24h: md?.total_volume?.[currency] ?? null,
    change24h: r(md?.price_change_percentage_24h ?? null),
    change7d: r(md?.price_change_percentage_7d ?? null),
    change30d: r(md?.price_change_percentage_30d ?? null),
    high24h: md?.high_24h?.[currency] ?? null,
    low24h: md?.low_24h?.[currency] ?? null,
    ath: md?.ath?.[currency] ?? null,
    athDate: md?.ath_date?.[currency] ?? null,
    athChangePercent: r(md?.ath_change_percentage?.[currency] ?? null),
    circulatingSupply: md?.circulating_supply ?? null,
    totalSupply: md?.total_supply ?? null,
    maxSupply: md?.max_supply ?? null,
    fdv: md?.fully_diluted_valuation?.[currency] ?? null,
    topExchanges: tickers,
    elapsedMs: Date.now() - start,
  });
}

/* ------------------------------------------------------------------ */
/*  orderbook                                                         */
/* ------------------------------------------------------------------ */

async function handleOrderbook(args: any, start: number): Promise<string> {
  const coinId = await resolveCoinId(args);
  const exchange = (args.exchange || "binance").toLowerCase();
  const depth = Math.min(Math.max(1, Number(args.depth) || 10), 50);

  const data = await cgGet(`/coins/${coinId}/tickers`, { exchange_ids: exchange, depth: true });

  // Respect the depth param -- slice to requested depth
  const tickers = (data.tickers || []).slice(0, depth).map((t: any) => ({
    pair: t.base + "/" + t.target,
    lastPrice: t.last ?? null,
    bidPrice: typeof t.last === "number" && typeof t.bid_ask_spread_percentage === "number"
      ? r(t.last * (1 - t.bid_ask_spread_percentage / 200))
      : null,
    askPrice: typeof t.last === "number" && typeof t.bid_ask_spread_percentage === "number"
      ? r(t.last * (1 + t.bid_ask_spread_percentage / 200))
      : null,
    spread: r(t.bid_ask_spread_percentage ?? null, 4),
    volume: t.volume ?? null,
    costToMoveUp2Pct: r(t.cost_to_move_up_usd ?? null),
    costToMoveDown2Pct: r(t.cost_to_move_down_usd ?? null),
    trustScore: t.trust_score ?? null,
  }));

  return JSON.stringify({
    status: "ok",
    action: "orderbook",
    coinId,
    exchange,
    depth,
    pairCount: tickers.length,
    pairs: tickers,
    note: "CoinGecko free tier provides spread and depth estimates. For real-time L2 orderbook, use exchange APIs directly.",
    elapsedMs: Date.now() - start,
  });
}

/* ------------------------------------------------------------------ */
/*  trades (OHLC candle data)                                         */
/* ------------------------------------------------------------------ */

async function handleTrades(args: any, start: number): Promise<string> {
  const coinId = await resolveCoinId(args);
  const currency = (args.currency || "usd").toLowerCase();
  // CoinGecko OHLC accepts: 1, 7, 14, 30, 90, 180, 365, max
  const validDays = [1, 7, 14, 30, 90, 180, 365];
  let days = Number(args.days) || 7;
  if (!validDays.includes(days)) {
    // Snap to nearest valid value
    days = validDays.reduce((prev, curr) => Math.abs(curr - days) < Math.abs(prev - days) ? curr : prev);
  }

  const data = await cgGet(`/coins/${coinId}/ohlc`, { vs_currency: currency, days });

  // CoinGecko OHLC returns [[timestamp, open, high, low, close], ...]
  const candles = (data || []).map((c: any[]) => ({
    timestamp: c[0],
    date: new Date(c[0]).toISOString(),
    open: c[1] ?? null,
    high: c[2] ?? null,
    low: c[3] ?? null,
    close: c[4] ?? null,
  }));

  return JSON.stringify({
    status: "ok",
    action: "trades",
    coinId,
    currency,
    days,
    candleCount: candles.length,
    candles,
    note: "OHLC candle data from CoinGecko. Granularity: 30min (1-2 days), 4h (3-30 days), 4d (31+ days).",
    elapsedMs: Date.now() - start,
  });
}

/* ------------------------------------------------------------------ */
/*  trending (cached)                                                 */
/* ------------------------------------------------------------------ */

async function handleTrending(start: number): Promise<string> {
  const data = await cachedFetch("trending", "/search/trending");

  const coins = (data.coins || []).map((item: any) => {
    const c = item.item;
    return {
      id: c.id,
      symbol: c.symbol?.toUpperCase(),
      name: c.name,
      rank: c.market_cap_rank ?? null,
      priceBtc: c.price_btc ?? null,
      score: c.score ?? null,
    };
  });

  const nfts = (data.nfts || []).slice(0, 5).map((n: any) => ({
    id: n.id,
    name: n.name,
    symbol: n.symbol,
    floorPriceChange24h: n.floor_price_in_native_currency ?? null,
  }));

  const cacheEntry = cache.get("trending");
  return JSON.stringify({
    status: "ok",
    action: "trending",
    coins,
    nfts,
    cached: cacheEntry ? Date.now() - cacheEntry.ts > 1000 : false,
    elapsedMs: Date.now() - start,
  });
}

/* ------------------------------------------------------------------ */
/*  global (cached)                                                   */
/* ------------------------------------------------------------------ */

async function handleGlobal(start: number): Promise<string> {
  const data = await cachedFetch("global", "/global");
  const d = data.data || {};

  const cacheEntry = cache.get("global");
  return JSON.stringify({
    status: "ok",
    action: "global",
    activeCryptos: d.active_cryptocurrencies ?? null,
    markets: d.markets ?? null,
    totalMarketCap: d.total_market_cap?.usd ?? null,
    totalVolume24h: d.total_volume?.usd ?? null,
    btcDominance: r(d.market_cap_percentage?.btc ?? null, 1),
    ethDominance: r(d.market_cap_percentage?.eth ?? null, 1),
    marketCapChange24h: r(d.market_cap_change_percentage_24h_usd ?? null),
    cached: cacheEntry ? Date.now() - cacheEntry.ts > 1000 : false,
    elapsedMs: Date.now() - start,
  });
}

/* ------------------------------------------------------------------ */
/*  categories (cached)                                               */
/* ------------------------------------------------------------------ */

async function handleCategories(start: number): Promise<string> {
  const data = await cachedFetch("categories", "/coins/categories");

  const categories = (data || []).slice(0, 30).map((c: any) => ({
    id: c.id,
    name: c.name,
    marketCap: c.market_cap ?? null,
    volume24h: c.volume_24h ?? null,
    change24h: r(c.market_cap_change_24h ?? null),
    topCoins: c.top_3_coins?.slice(0, 3) ?? [],
  }));

  const cacheEntry = cache.get("categories");
  return JSON.stringify({
    status: "ok",
    action: "categories",
    count: categories.length,
    categories,
    cached: cacheEntry ? Date.now() - cacheEntry.ts > 1000 : false,
    elapsedMs: Date.now() - start,
  });
}

/* ------------------------------------------------------------------ */
/*  exchanges                                                         */
/* ------------------------------------------------------------------ */

async function handleExchanges(args: any, start: number): Promise<string> {
  const perPage = Math.min(Math.max(1, Number(args.perPage) || 20), 100);

  const data = await cgGet("/exchanges", { per_page: perPage, page: 1 });

  const exchanges = (data || []).map((e: any) => ({
    id: e.id,
    name: e.name,
    rank: e.trust_score_rank ?? null,
    trustScore: e.trust_score ?? null,
    volume24hBtc: r(e.trade_volume_24h_btc ?? null),
    year: e.year_established ?? null,
    country: e.country ?? null,
    url: e.url ?? null,
  }));

  return JSON.stringify({ status: "ok", action: "exchanges", count: exchanges.length, exchanges, elapsedMs: Date.now() - start });
}

/* ------------------------------------------------------------------ */
/*  fear_greed (cached)                                               */
/* ------------------------------------------------------------------ */

async function handleFearGreed(args: any, start: number): Promise<string> {
  const limit = Math.min(Math.max(1, Number(args.limit) || 10), 30);

  try {
    const data = await cachedAxios("fng", `https://api.alternative.me/fng/?limit=${limit}`);
    const entries = (data?.data || []).map((e: any) => ({
      value: parseInt(e.value, 10),
      classification: e.value_classification,
      timestamp: e.timestamp,
      date: new Date(parseInt(e.timestamp, 10) * 1000).toISOString().split("T")[0],
    }));

    const current = entries[0];
    const trend = entries.length >= 2
      ? current.value > entries[1].value ? "improving" : current.value < entries[1].value ? "declining" : "stable"
      : "unknown";

    const cacheEntry = cache.get("fng");
    return JSON.stringify({
      status: "ok",
      action: "fear_greed",
      current: current || null,
      trend,
      history: entries,
      interpretation: current ? interpretFearGreed(current.value) : null,
      cached: cacheEntry ? Date.now() - cacheEntry.ts > 1000 : false,
      elapsedMs: Date.now() - start,
    });
  } catch (err: any) {
    return fail(`Fear & Greed API unavailable: ${err.message}`, "network", start);
  }
}

function interpretFearGreed(value: number): string {
  if (value <= 10) return "Extreme Fear - historically a strong buy signal (max fear = max opportunity)";
  if (value <= 25) return "Fear - market is pessimistic, contrarian buying zone";
  if (value <= 45) return "Moderate Fear - caution, but opportunities emerging";
  if (value <= 55) return "Neutral - market is undecided";
  if (value <= 75) return "Greed - market is optimistic, consider taking profits";
  if (value <= 90) return "High Greed - elevated risk, tighten stops";
  return "Extreme Greed - historically a strong sell signal (max greed = max risk)";
}
