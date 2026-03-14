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
        "Action: markets (top coins by market cap), ticker (price/volume/change for a coin), orderbook (bid/ask depth), trades (recent trades), trending (trending coins), global (global market stats), categories (sector performance), exchanges (exchange rankings), fear_greed (Fear & Greed Index).",
    },
    // Common
    coinId: { type: "string", description: "CoinGecko coin ID (e.g. 'bitcoin', 'ethereum', 'solana'). Use for ticker, orderbook, trades." },
    symbol: { type: "string", description: "Ticker symbol (e.g. 'BTC', 'ETH'). Auto-resolved to coinId if coinId not provided." },
    currency: { type: "string", description: "Quote currency for prices (default: 'usd')" },

    // Markets
    category: { type: "string", description: "Filter markets by category (e.g. 'decentralized-finance-defi', 'layer-1')" },
    perPage: { type: "number", description: "Results per page for markets (default: 20, max: 100)" },
    page: { type: "number", description: "Page number (default: 1)" },
    order: {
      type: "string",
      enum: ["market_cap_desc", "market_cap_asc", "volume_desc", "volume_asc"],
      description: "Sort order for markets (default: market_cap_desc)",
    },

    // Orderbook
    depth: { type: "number", description: "Orderbook depth — number of bid/ask levels (default: 10, max: 50)" },
    exchange: { type: "string", description: "Exchange for orderbook/trades (e.g. 'binance', 'coinbase')" },
  },
  required: ["action"],
};

/* ────────────────────── constants ────────────────────── */

const CG_BASE = "https://api.coingecko.com/api/v3";
const MAX_RETRIES = 2;
const TIMEOUT = 10000;

// Common symbol → coinId mapping (saves an API call)
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

/* ────────────────────── helpers ────────────────────── */

function fail(error: string, category: string, start: number): string {
  return JSON.stringify({ status: "error", error, errorCategory: category, elapsedMs: Date.now() - start });
}

function resolveCoinId(args: any): string {
  if (args.coinId) return args.coinId.toLowerCase().trim();
  if (args.symbol) {
    const upper = args.symbol.toUpperCase().trim().replace("/USDT", "").replace("/USD", "");
    const mapped = SYMBOL_MAP[upper];
    if (mapped) return mapped;
    return upper.toLowerCase(); // best guess
  }
  throw new Error("coinId or symbol is required");
}

function mapError(error: any): { category: string; message: string; retryable: boolean } {
  const status = error.response?.status;
  if (status === 429) return { category: "rate_limited", message: "CoinGecko rate limit. Try again in 30-60s.", retryable: true };
  if (status === 404) return { category: "not_found", message: "Coin or endpoint not found. Check coinId.", retryable: false };
  if (status && status >= 500) return { category: "server", message: `CoinGecko server error (${status}).`, retryable: true };
  if (["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED"].includes(error.code)) {
    return { category: "network", message: `Network error: ${error.message}`, retryable: true };
  }
  return { category: "unknown", message: error.message || "Unknown error", retryable: false };
}

async function cgGet(path: string, params?: Record<string, any>): Promise<any> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const resp = await axios.get(`${CG_BASE}${path}`, { params, timeout: TIMEOUT });
      return resp.data;
    } catch (err: any) {
      const mapped = mapError(err);
      if (attempt < MAX_RETRIES && mapped.retryable) {
        await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 1500 + Math.random() * 500));
        continue;
      }
      const enriched = new Error(mapped.message) as any;
      enriched.category = mapped.category;
      throw enriched;
    }
  }
}

function r(n: number, dec = 2): number {
  return Math.round(n * Math.pow(10, dec)) / Math.pow(10, dec);
}

/* ────────────────────── execute ────────────────────── */

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
      case "exchanges": return await handleExchanges(start);
      case "fear_greed": return await handleFearGreed(start);
      default:
        throw new Error(`Unknown action: ${action}. Use: markets, ticker, orderbook, trades, trending, global, categories, exchanges, fear_greed`);
    }
  } catch (err: any) {
    return fail(err.message, (err as any).category || "unknown", start);
  }
}

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
    rank: c.market_cap_rank,
    price: c.current_price,
    marketCap: c.market_cap,
    volume24h: c.total_volume,
    change1h: c.price_change_percentage_1h_in_currency ? r(c.price_change_percentage_1h_in_currency) : null,
    change24h: c.price_change_percentage_24h ? r(c.price_change_percentage_24h) : null,
    change7d: c.price_change_percentage_7d_in_currency ? r(c.price_change_percentage_7d_in_currency) : null,
    high24h: c.high_24h,
    low24h: c.low_24h,
    ath: c.ath,
    athChangePercent: c.ath_change_percentage ? r(c.ath_change_percentage) : null,
    circulatingSupply: c.circulating_supply,
    totalSupply: c.total_supply,
  }));

  return JSON.stringify({ status: "ok", action: "markets", currency, count: coins.length, page, coins, elapsedMs: Date.now() - start });
}

async function handleTicker(args: any, start: number): Promise<string> {
  const coinId = resolveCoinId(args);
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
    price: t.last,
    volume: t.volume,
    spread: t.bid_ask_spread_percentage ? r(t.bid_ask_spread_percentage, 4) : null,
    trustScore: t.trust_score,
  }));

  return JSON.stringify({
    status: "ok",
    action: "ticker",
    id: data.id,
    symbol: data.symbol?.toUpperCase(),
    name: data.name,
    rank: data.market_cap_rank,
    price: md?.current_price?.[currency],
    marketCap: md?.market_cap?.[currency],
    volume24h: md?.total_volume?.[currency],
    change24h: md?.price_change_percentage_24h ? r(md.price_change_percentage_24h) : null,
    change7d: md?.price_change_percentage_7d ? r(md.price_change_percentage_7d) : null,
    change30d: md?.price_change_percentage_30d ? r(md.price_change_percentage_30d) : null,
    high24h: md?.high_24h?.[currency],
    low24h: md?.low_24h?.[currency],
    ath: md?.ath?.[currency],
    athDate: md?.ath_date?.[currency],
    athChangePercent: md?.ath_change_percentage?.[currency] ? r(md.ath_change_percentage[currency]) : null,
    circulatingSupply: md?.circulating_supply,
    totalSupply: md?.total_supply,
    maxSupply: md?.max_supply,
    fdv: md?.fully_diluted_valuation?.[currency],
    topExchanges: tickers,
    elapsedMs: Date.now() - start,
  });
}

async function handleOrderbook(args: any, start: number): Promise<string> {
  const coinId = resolveCoinId(args);
  const exchange = (args.exchange || "binance").toLowerCase();
  const depth = Math.min(Math.max(1, Number(args.depth) || 10), 50);

  // CoinGecko tickers endpoint gives some depth info
  const data = await cgGet(`/coins/${coinId}/tickers`, { exchange_ids: exchange, depth: true });

  const tickers = (data.tickers || []).slice(0, 5).map((t: any) => ({
    pair: t.base + "/" + t.target,
    lastPrice: t.last,
    bidPrice: t.last * (1 - (t.bid_ask_spread_percentage || 0) / 200),
    askPrice: t.last * (1 + (t.bid_ask_spread_percentage || 0) / 200),
    spread: t.bid_ask_spread_percentage ? r(t.bid_ask_spread_percentage, 4) : null,
    volume: t.volume,
    costToMoveUp2Pct: t.cost_to_move_up_usd ? r(t.cost_to_move_up_usd) : null,
    costToMoveDown2Pct: t.cost_to_move_down_usd ? r(t.cost_to_move_down_usd) : null,
    trustScore: t.trust_score,
  }));

  return JSON.stringify({
    status: "ok",
    action: "orderbook",
    coinId,
    exchange,
    pairCount: tickers.length,
    pairs: tickers,
    note: "CoinGecko free tier provides spread and depth estimates. For real-time L2 orderbook, use exchange APIs directly.",
    elapsedMs: Date.now() - start,
  });
}

async function handleTrades(args: any, start: number): Promise<string> {
  const coinId = resolveCoinId(args);
  const exchange = (args.exchange || "binance").toLowerCase();

  const data = await cgGet(`/coins/${coinId}/tickers`, { exchange_ids: exchange });

  const tickers = (data.tickers || []).slice(0, 10).map((t: any) => ({
    pair: t.base + "/" + t.target,
    lastPrice: t.last,
    volume: t.volume,
    convertedVolume: t.converted_volume?.usd ? r(t.converted_volume.usd) : null,
    timestamp: t.timestamp,
    lastTraded: t.last_traded_at,
    spread: t.bid_ask_spread_percentage ? r(t.bid_ask_spread_percentage, 4) : null,
  }));

  return JSON.stringify({
    status: "ok",
    action: "trades",
    coinId,
    exchange,
    pairs: tickers,
    elapsedMs: Date.now() - start,
  });
}

async function handleTrending(start: number): Promise<string> {
  const data = await cgGet("/search/trending");

  const coins = (data.coins || []).map((item: any) => {
    const c = item.item;
    return {
      id: c.id,
      symbol: c.symbol?.toUpperCase(),
      name: c.name,
      rank: c.market_cap_rank,
      priceBtc: c.price_btc,
      score: c.score,
    };
  });

  const nfts = (data.nfts || []).slice(0, 5).map((n: any) => ({
    id: n.id,
    name: n.name,
    symbol: n.symbol,
    floorPriceChange24h: n.floor_price_in_native_currency,
  }));

  return JSON.stringify({ status: "ok", action: "trending", coins, nfts, elapsedMs: Date.now() - start });
}

async function handleGlobal(start: number): Promise<string> {
  const data = await cgGet("/global");
  const d = data.data;

  return JSON.stringify({
    status: "ok",
    action: "global",
    activeCryptos: d.active_cryptocurrencies,
    markets: d.markets,
    totalMarketCap: d.total_market_cap?.usd ? r(d.total_market_cap.usd) : null,
    totalVolume24h: d.total_volume?.usd ? r(d.total_volume.usd) : null,
    btcDominance: d.market_cap_percentage?.btc ? r(d.market_cap_percentage.btc, 1) : null,
    ethDominance: d.market_cap_percentage?.eth ? r(d.market_cap_percentage.eth, 1) : null,
    marketCapChange24h: d.market_cap_change_percentage_24h_usd ? r(d.market_cap_change_percentage_24h_usd) : null,
    defiMarketCap: d.total_market_cap?.usd && d.market_cap_percentage ? null : undefined,
    elapsedMs: Date.now() - start,
  });
}

async function handleCategories(start: number): Promise<string> {
  const data = await cgGet("/coins/categories");

  const categories = (data || []).slice(0, 30).map((c: any) => ({
    id: c.id,
    name: c.name,
    marketCap: c.market_cap,
    volume24h: c.volume_24h,
    change24h: c.market_cap_change_24h ? r(c.market_cap_change_24h) : null,
    topCoins: c.top_3_coins?.slice(0, 3),
  }));

  return JSON.stringify({ status: "ok", action: "categories", count: categories.length, categories, elapsedMs: Date.now() - start });
}

async function handleExchanges(start: number): Promise<string> {
  const data = await cgGet("/exchanges", { per_page: 20, page: 1 });

  const exchanges = (data || []).map((e: any) => ({
    id: e.id,
    name: e.name,
    rank: e.trust_score_rank,
    trustScore: e.trust_score,
    volume24hBtc: e.trade_volume_24h_btc ? r(e.trade_volume_24h_btc) : null,
    year: e.year_established,
    country: e.country,
    url: e.url,
  }));

  return JSON.stringify({ status: "ok", action: "exchanges", count: exchanges.length, exchanges, elapsedMs: Date.now() - start });
}

async function handleFearGreed(start: number): Promise<string> {
  // Alternative.me Fear & Greed Index (free, no key)
  try {
    const resp = await axios.get("https://api.alternative.me/fng/?limit=10", { timeout: TIMEOUT });
    const entries = (resp.data?.data || []).map((e: any) => ({
      value: parseInt(e.value, 10),
      classification: e.value_classification,
      timestamp: e.timestamp,
      date: new Date(parseInt(e.timestamp, 10) * 1000).toISOString().split("T")[0],
    }));

    const current = entries[0];
    const trend = entries.length >= 2
      ? current.value > entries[1].value ? "improving" : current.value < entries[1].value ? "declining" : "stable"
      : "unknown";

    return JSON.stringify({
      status: "ok",
      action: "fear_greed",
      current: current || null,
      trend,
      history: entries,
      interpretation: current ? interpretFearGreed(current.value) : null,
      elapsedMs: Date.now() - start,
    });
  } catch (err: any) {
    // Fallback — just return error gracefully
    return fail(`Fear & Greed API unavailable: ${err.message}`, "network", start);
  }
}

function interpretFearGreed(value: number): string {
  if (value <= 10) return "Extreme Fear — historically a strong buy signal (max fear = max opportunity)";
  if (value <= 25) return "Fear — market is pessimistic, contrarian buying zone";
  if (value <= 45) return "Moderate Fear — caution, but opportunities emerging";
  if (value <= 55) return "Neutral — market is undecided";
  if (value <= 75) return "Greed — market is optimistic, consider taking profits";
  if (value <= 90) return "High Greed — elevated risk, tighten stops";
  return "Extreme Greed — historically a strong sell signal (max greed = max risk)";
}
