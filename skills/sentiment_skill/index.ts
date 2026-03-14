import axios from "axios";

export const parameters = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["crypto_news", "coin_sentiment", "market_overview", "social_stats", "events"],
      description:
        "Action: crypto_news (latest crypto headlines), coin_sentiment (sentiment for a specific coin), market_overview (broad market sentiment snapshot), social_stats (social media metrics for a coin), events (project status updates or trending coins).",
    },
    coinId: { type: "string", description: "CoinGecko coin ID (e.g. 'bitcoin', 'ethereum')" },
    symbol: { type: "string", description: "Ticker symbol (e.g. 'BTC'). Auto-resolved to coinId." },
    query: { type: "string", description: "Search query for news (e.g. 'bitcoin etf', 'solana defi')" },
    limit: { type: "number", description: "Max results (default: 10)" },
    currency: { type: "string", description: "Quote currency (default: 'usd')" },
  },
  required: ["action"],
};

/* ------------------------------------------------------------------ */
/*  Constants                                                         */
/* ------------------------------------------------------------------ */

const CG_BASE = "https://api.coingecko.com/api/v3";
const TIMEOUT = 10_000;
const MAX_RETRIES = 2;

const SYMBOL_MAP: Record<string, string> = {
  BTC: "bitcoin", ETH: "ethereum", SOL: "solana", BNB: "binancecoin",
  XRP: "ripple", ADA: "cardano", AVAX: "avalanche-2", DOGE: "dogecoin",
  DOT: "polkadot", MATIC: "matic-network", LINK: "chainlink", UNI: "uniswap",
  ATOM: "cosmos", LTC: "litecoin", NEAR: "near", APT: "aptos",
  OP: "optimism", ARB: "arbitrum", FIL: "filecoin", INJ: "injective-protocol",
  SUI: "sui", PEPE: "pepe", SHIB: "shiba-inu", AAVE: "aave",
};

/* Cached /coins/list for dynamic symbol resolution */
let coinListCache: Array<{ id: string; symbol: string }> | null = null;
let coinListCacheTs = 0;
const COIN_LIST_TTL = 3_600_000; // 1 hour

/* RSS sources -- primary: direct XML fetch, fallback: rss2json proxy */
const RSS_FEEDS = [
  {
    name: "CoinDesk",
    directUrl: "https://www.coindesk.com/arc/outboundfeeds/rss/",
    proxyUrl: "https://api.rss2json.com/v1/api.json?rss_url=https%3A%2F%2Fwww.coindesk.com%2Farc%2Foutboundfeeds%2Frss%2F",
  },
  {
    name: "CoinTelegraph",
    directUrl: "https://cointelegraph.com/rss",
    proxyUrl: "https://api.rss2json.com/v1/api.json?rss_url=https%3A%2F%2Fcointelegraph.com%2Frss",
  },
];

/* ------------------------------------------------------------------ */
/*  TTL cache                                                         */
/* ------------------------------------------------------------------ */

interface CacheEntry { data: any; ts: number; }
const cache = new Map<string, CacheEntry>();
const TTL: Record<string, number> = {
  global: 120_000,    // 2 min
  trending: 300_000,  // 5 min
  fng: 600_000,       // 10 min
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

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

type ErrorCategory = "validation" | "not_found" | "rate_limited" | "network" | "unknown";

function categorizeError(err: any): ErrorCategory {
  const status = err.response?.status;
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  if (status === 400 || status === 422) return "validation";
  const code = err.code;
  if (["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"].includes(code)) return "network";
  if (status && status >= 500) return "network";
  return "unknown";
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
  throw Object.assign(new Error("coinId or symbol is required"), { category: "validation" });
}

async function getCoinList(): Promise<Array<{ id: string; symbol: string }>> {
  if (coinListCache && Date.now() - coinListCacheTs < COIN_LIST_TTL) return coinListCache;
  try {
    const data = await fetchWithRetry(`${CG_BASE}/coins/list`, { include_platform: false });
    coinListCache = (data || []).map((c: any) => ({ id: c.id, symbol: c.symbol }));
    coinListCacheTs = Date.now();
    return coinListCache!;
  } catch {
    return coinListCache || [];
  }
}

/** Round number safely -- treats null/undefined as null, 0 stays 0 */
function r(n: number | null | undefined, dec = 2): number | null {
  if (n === null || n === undefined) return null;
  return Math.round(n * Math.pow(10, dec)) / Math.pow(10, dec);
}

async function fetchWithRetry(url: string, params?: any): Promise<any> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const resp = await axios.get(url, { params, timeout: TIMEOUT });
      return resp.data;
    } catch (err: any) {
      const status = err.response?.status;
      const retryable = status === 429 || (status && status >= 500) || ["ETIMEDOUT", "ECONNRESET"].includes(err.code);
      if (attempt < MAX_RETRIES && retryable) {
        await new Promise((resolve) => setTimeout(resolve, Math.pow(2, attempt) * 1500));
        continue;
      }
      throw err;
    }
  }
}

/* Cached fetch -- checks TTL cache before network */
async function cachedFetch(key: string, url: string, params?: any): Promise<any> {
  const hit = getCached(key);
  if (hit !== null) return hit;
  const data = await fetchWithRetry(url, params);
  setCache(key, data);
  return data;
}

/* ------------------------------------------------------------------ */
/*  RSS parsing (direct XML + rss2json proxy fallback)                */
/* ------------------------------------------------------------------ */

interface Article {
  title: string;
  link: string;
  source: string;
  pubDate: string;
  description: string;
}

/** Minimal XML RSS item extractor -- no external dependency */
function parseRssXml(xml: string, sourceName: string): Article[] {
  const items: Article[] = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let match: RegExpExecArray | null;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const title = extractTag(block, "title");
    const link = extractTag(block, "link");
    const pubDate = extractTag(block, "pubDate");
    const description = stripHtml(extractTag(block, "description")).slice(0, 200);
    if (title) items.push({ title, link, source: sourceName, pubDate, description });
  }
  return items;
}

function extractTag(block: string, tag: string): string {
  // Handle CDATA: <title><![CDATA[Some text]]></title>
  const cdataRe = new RegExp(`<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${tag}>`, "i");
  const cdataMatch = cdataRe.exec(block);
  if (cdataMatch) return cdataMatch[1].trim();
  // Plain text
  const plainRe = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i");
  const plainMatch = plainRe.exec(block);
  return plainMatch ? plainMatch[1].trim() : "";
}

async function fetchArticlesFromSource(feed: typeof RSS_FEEDS[number]): Promise<Article[]> {
  // Try direct RSS XML first
  try {
    const resp = await axios.get(feed.directUrl, { timeout: TIMEOUT, responseType: "text" });
    const articles = parseRssXml(resp.data, feed.name);
    if (articles.length > 0) return articles;
  } catch { /* fall through to proxy */ }

  // Fallback: rss2json proxy
  try {
    const data = await fetchWithRetry(feed.proxyUrl);
    if (data?.items) {
      return data.items.map((item: any) => ({
        title: item.title || "",
        link: item.link || "",
        source: feed.name,
        pubDate: item.pubDate || "",
        description: stripHtml(item.description || "").slice(0, 200),
      }));
    }
  } catch { /* both failed */ }

  return [];
}

/* ------------------------------------------------------------------ */
/*  Execute                                                           */
/* ------------------------------------------------------------------ */

export async function execute(args: any): Promise<string> {
  const start = Date.now();
  const { action } = args;

  try {
    switch (action) {
      case "crypto_news": return await handleNews(args, start);
      case "coin_sentiment": return await handleCoinSentiment(args, start);
      case "market_overview": return await handleMarketOverview(args, start);
      case "social_stats": return await handleSocialStats(args, start);
      case "events": return await handleEvents(args, start);
      default:
        throw Object.assign(
          new Error(`Unknown action: ${action}. Use: crypto_news, coin_sentiment, market_overview, social_stats, events`),
          { category: "validation" as ErrorCategory },
        );
    }
  } catch (err: any) {
    return fail(err.message, err.category || categorizeError(err), start);
  }
}

/* ------------------------------------------------------------------ */
/*  crypto_news                                                       */
/* ------------------------------------------------------------------ */

async function handleNews(args: any, start: number): Promise<string> {
  const limit = Math.min(Math.max(1, Number(args.limit) || 10), 30);
  const query = args.query?.toLowerCase() || "";

  // Fetch from all RSS sources in parallel (direct XML with proxy fallback)
  const fetches = RSS_FEEDS.map((feed) => fetchArticlesFromSource(feed));
  const results = await Promise.all(fetches);
  let allArticles = results.flat();

  // Filter by query if provided
  if (query) {
    const terms = query.split(/\s+/);
    allArticles = allArticles.filter((a) => {
      const text = `${a.title} ${a.description}`.toLowerCase();
      return terms.some((t: string) => text.includes(t));
    });
  }

  // Sort by date descending
  allArticles.sort((a, b) => new Date(b.pubDate).getTime() - new Date(a.pubDate).getTime());
  allArticles = allArticles.slice(0, limit);

  return JSON.stringify({
    status: "ok",
    action: "crypto_news",
    query: query || undefined,
    count: allArticles.length,
    articles: allArticles,
    elapsedMs: Date.now() - start,
  });
}

/* ------------------------------------------------------------------ */
/*  coin_sentiment                                                    */
/* ------------------------------------------------------------------ */

async function handleCoinSentiment(args: any, start: number): Promise<string> {
  const coinId = await resolveCoinId(args);
  const currency = (args.currency || "usd").toLowerCase();

  const [coinData, fngData] = await Promise.all([
    fetchWithRetry(`${CG_BASE}/coins/${coinId}`, {
      localization: false,
      tickers: false,
      market_data: true,
      community_data: true,
      developer_data: true,
    }),
    cachedFetch("fng", "https://api.alternative.me/fng/?limit=1").catch(() => null),
  ]);

  const md = coinData.market_data;
  const community = coinData.community_data || {};

  // Build sentiment signals
  const signals: Array<{ signal: string; value: any; interpretation: string }> = [];

  // Price momentum signals -- use explicit null checks to preserve 0
  const change24h: number | null = md?.price_change_percentage_24h ?? null;
  const change7d: number | null = md?.price_change_percentage_7d ?? null;
  const change30d: number | null = md?.price_change_percentage_30d ?? null;

  if (change24h !== null) {
    signals.push({
      signal: "24h price change",
      value: r(change24h) + "%",
      interpretation: change24h > 5 ? "Strong bullish" : change24h > 0 ? "Bullish" : change24h > -5 ? "Bearish" : "Strong bearish",
    });
  }
  if (change7d !== null) {
    signals.push({
      signal: "7d price change",
      value: r(change7d) + "%",
      interpretation: change7d > 10 ? "Strong bullish momentum" : change7d > 0 ? "Positive trend" : change7d > -10 ? "Negative trend" : "Strong bearish momentum",
    });
  }

  // Volume signal -- safe number check
  const vol = md?.total_volume?.[currency];
  const mcap = md?.market_cap?.[currency];
  if (typeof vol === "number" && typeof mcap === "number" && mcap > 0) {
    const volToMcap = vol / mcap;
    signals.push({
      signal: "Volume/MarketCap ratio",
      value: r(volToMcap, 4),
      interpretation: volToMcap > 0.3 ? "Very high activity (breakout/panic)" : volToMcap > 0.1 ? "Above average activity" : "Normal activity",
    });
  }

  // ATH distance -- use ?? null to preserve 0
  const athDist: number | null = md?.ath_change_percentage?.[currency] ?? null;
  if (athDist !== null) {
    signals.push({
      signal: "Distance from ATH",
      value: r(athDist) + "%",
      interpretation: athDist > -10 ? "Near ATH - caution" : athDist > -30 ? "Healthy range" : athDist > -60 ? "Significant discount" : "Deep discount from ATH",
    });
  }

  // Community signals
  if (typeof community.twitter_followers === "number") {
    signals.push({
      signal: "Twitter followers",
      value: community.twitter_followers,
      interpretation: community.twitter_followers > 1_000_000 ? "Major project" : community.twitter_followers > 100_000 ? "Established project" : "Growing project",
    });
  }

  // Fear & Greed
  const fngValue = fngData?.data?.[0]?.value != null ? parseInt(fngData.data[0].value, 10) : null;
  if (fngValue !== null) {
    signals.push({
      signal: "Fear & Greed Index",
      value: fngValue,
      interpretation: fngData.data[0].value_classification,
    });
  }

  // Overall sentiment score (weighted)
  let sentimentScore = 50; // neutral baseline
  if (change24h !== null) sentimentScore += Math.max(-20, Math.min(20, change24h * 2));
  if (change7d !== null) sentimentScore += Math.max(-15, Math.min(15, change7d));
  if (fngValue !== null) sentimentScore += (fngValue - 50) * 0.3;
  sentimentScore = Math.max(0, Math.min(100, sentimentScore));

  let sentimentLabel: string;
  if (sentimentScore >= 75) sentimentLabel = "Very Bullish";
  else if (sentimentScore >= 60) sentimentLabel = "Bullish";
  else if (sentimentScore >= 40) sentimentLabel = "Neutral";
  else if (sentimentScore >= 25) sentimentLabel = "Bearish";
  else sentimentLabel = "Very Bearish";

  return JSON.stringify({
    status: "ok",
    action: "coin_sentiment",
    coinId,
    symbol: coinData.symbol?.toUpperCase(),
    name: coinData.name,
    sentimentScore: r(sentimentScore, 0),
    sentimentLabel,
    signals,
    priceData: {
      price: md?.current_price?.[currency] ?? null,
      change24h: r(change24h),
      change7d: r(change7d),
      change30d: r(change30d),
      volume24h: md?.total_volume?.[currency] ?? null,
      marketCap: md?.market_cap?.[currency] ?? null,
    },
    elapsedMs: Date.now() - start,
  });
}

/* ------------------------------------------------------------------ */
/*  market_overview                                                   */
/* ------------------------------------------------------------------ */

async function handleMarketOverview(args: any, start: number): Promise<string> {
  const [global, fng, trending] = await Promise.all([
    cachedFetch("global", `${CG_BASE}/global`),
    cachedFetch("fng", "https://api.alternative.me/fng/?limit=7").catch(() => null),
    cachedFetch("trending", `${CG_BASE}/search/trending`).catch(() => null),
  ]);

  const gd = global?.data || {};
  const fngCurrent = fng?.data?.[0];
  const fngHistory = (fng?.data || []).map((e: any) => ({
    value: parseInt(e.value, 10),
    date: new Date(parseInt(e.timestamp, 10) * 1000).toISOString().split("T")[0],
  }));

  const trendingCoins = (trending?.coins || []).slice(0, 7).map((item: any) => ({
    symbol: item.item?.symbol?.toUpperCase(),
    name: item.item?.name,
    rank: item.item?.market_cap_rank,
  }));

  const marketCapChange = gd.market_cap_change_percentage_24h_usd ?? 0;
  let marketHealth: string;
  if (marketCapChange > 3) marketHealth = "Strong Rally";
  else if (marketCapChange > 0) marketHealth = "Positive";
  else if (marketCapChange > -3) marketHealth = "Slightly Negative";
  else marketHealth = "Selloff";

  return JSON.stringify({
    status: "ok",
    action: "market_overview",
    marketHealth,
    totalMarketCap: gd.total_market_cap?.usd ?? null,
    totalVolume24h: gd.total_volume?.usd ?? null,
    marketCapChange24h: r(marketCapChange),
    btcDominance: r(gd.market_cap_percentage?.btc ?? null, 1),
    ethDominance: r(gd.market_cap_percentage?.eth ?? null, 1),
    activeCryptos: gd.active_cryptocurrencies ?? null,
    fearGreed: fngCurrent ? {
      value: parseInt(fngCurrent.value, 10),
      label: fngCurrent.value_classification,
      trend: fngHistory,
    } : null,
    trending: trendingCoins,
    elapsedMs: Date.now() - start,
  });
}

/* ------------------------------------------------------------------ */
/*  social_stats                                                      */
/* ------------------------------------------------------------------ */

async function handleSocialStats(args: any, start: number): Promise<string> {
  const coinId = await resolveCoinId(args);

  const data = await fetchWithRetry(`${CG_BASE}/coins/${coinId}`, {
    localization: false,
    tickers: false,
    market_data: false,
    community_data: true,
    developer_data: true,
  });

  const community = data.community_data || {};
  const developer = data.developer_data || {};

  return JSON.stringify({
    status: "ok",
    action: "social_stats",
    coinId,
    symbol: data.symbol?.toUpperCase(),
    name: data.name,
    community: {
      twitterFollowers: community.twitter_followers ?? null,
      redditSubscribers: community.reddit_subscribers ?? null,
      redditActiveAccounts48h: community.reddit_accounts_active_48h ?? null,
      redditAvgPosts48h: r(community.reddit_average_posts_48h ?? null),
      redditAvgComments48h: r(community.reddit_average_comments_48h ?? null),
      telegramChannelMembers: community.telegram_channel_user_count ?? null,
    },
    developer: {
      forks: developer.forks ?? null,
      stars: developer.stars ?? null,
      subscribers: developer.subscribers ?? null,
      totalIssues: developer.total_issues ?? null,
      closedIssues: developer.closed_issues ?? null,
      pullRequestsMerged: developer.pull_requests_merged ?? null,
      pullRequestContributors: developer.pull_request_contributors ?? null,
      commitCount4Weeks: developer.commit_count_4_weeks ?? null,
    },
    links: {
      homepage: data.links?.homepage?.[0] || null,
      github: data.links?.repos_url?.github?.[0] || null,
      twitter: data.links?.twitter_screen_name ? `https://twitter.com/${data.links.twitter_screen_name}` : null,
      reddit: data.links?.subreddit_url || null,
      telegram: data.links?.telegram_channel_identifier ? `https://t.me/${data.links.telegram_channel_identifier}` : null,
    },
    elapsedMs: Date.now() - start,
  });
}

/* ------------------------------------------------------------------ */
/*  events                                                            */
/* ------------------------------------------------------------------ */

async function handleEvents(args: any, start: number): Promise<string> {
  const limit = Math.min(Math.max(1, Number(args.limit) || 10), 50);
  const coinId = args.coinId || args.symbol ? await resolveCoinId(args) : null;

  if (coinId) {
    const data = await fetchWithRetry(`${CG_BASE}/coins/${coinId}/status_updates`, { per_page: limit });
    const updates = (data?.status_updates || []).slice(0, limit).map((u: any) => ({
      title: u.title,
      description: u.description?.slice(0, 300),
      category: u.category,
      createdAt: u.created_at,
      project: u.project?.name,
    }));

    return JSON.stringify({
      status: "ok",
      action: "events",
      coinId,
      count: updates.length,
      updates,
      elapsedMs: Date.now() - start,
    });
  }

  // No coin specified -- return trending coins, respecting limit
  const trending = await cachedFetch("trending", `${CG_BASE}/search/trending`);
  const coins = (trending?.coins || []).slice(0, limit).map((item: any) => ({
    symbol: item.item?.symbol?.toUpperCase(),
    name: item.item?.name,
    rank: item.item?.market_cap_rank,
    note: "Trending on CoinGecko",
  }));

  return JSON.stringify({
    status: "ok",
    action: "events",
    note: "Showing trending coins as event proxy. Provide coinId for project-specific updates.",
    count: coins.length,
    trending: coins,
    elapsedMs: Date.now() - start,
  });
}

/* ------------------------------------------------------------------ */
/*  Utility                                                           */
/* ------------------------------------------------------------------ */

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}
