import axios from "axios";

export const parameters = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["crypto_news", "coin_sentiment", "market_overview", "social_stats", "events"],
      description:
        "Action: crypto_news (latest crypto headlines), coin_sentiment (sentiment for a specific coin), market_overview (broad market sentiment snapshot), social_stats (social media metrics for a coin), events (upcoming crypto events).",
    },
    coinId: { type: "string", description: "CoinGecko coin ID (e.g. 'bitcoin', 'ethereum')" },
    symbol: { type: "string", description: "Ticker symbol (e.g. 'BTC'). Auto-resolved to coinId." },
    query: { type: "string", description: "Search query for news (e.g. 'bitcoin etf', 'solana defi')" },
    limit: { type: "number", description: "Max results (default: 10)" },
    currency: { type: "string", description: "Quote currency (default: 'usd')" },
  },
  required: ["action"],
};

/* ────────────────────── constants ────────────────────── */

const CG_BASE = "https://api.coingecko.com/api/v3";
const TIMEOUT = 10000;
const MAX_RETRIES = 2;

const SYMBOL_MAP: Record<string, string> = {
  BTC: "bitcoin", ETH: "ethereum", SOL: "solana", BNB: "binancecoin",
  XRP: "ripple", ADA: "cardano", AVAX: "avalanche-2", DOGE: "dogecoin",
  DOT: "polkadot", MATIC: "matic-network", LINK: "chainlink", UNI: "uniswap",
  ATOM: "cosmos", LTC: "litecoin", NEAR: "near", APT: "aptos",
  OP: "optimism", ARB: "arbitrum", FIL: "filecoin", INJ: "injective-protocol",
  SUI: "sui", PEPE: "pepe", SHIB: "shiba-inu", AAVE: "aave",
};

// RSS-to-JSON proxy feeds (free, no API key)
const NEWS_SOURCES = [
  { name: "CoinDesk", url: "https://api.rss2json.com/v1/api.json?rss_url=https%3A%2F%2Fwww.coindesk.com%2Farc%2Foutboundfeeds%2Frss%2F" },
  { name: "CoinTelegraph", url: "https://api.rss2json.com/v1/api.json?rss_url=https%3A%2F%2Fcointelegraph.com%2Frss" },
];

/* ────────────────────── helpers ────────────────────── */

function fail(error: string, category: string, start: number): string {
  return JSON.stringify({ status: "error", error, errorCategory: category, elapsedMs: Date.now() - start });
}

function resolveCoinId(args: any): string {
  if (args.coinId) return args.coinId.toLowerCase().trim();
  if (args.symbol) {
    const upper = args.symbol.toUpperCase().trim().replace("/USDT", "").replace("/USD", "");
    return SYMBOL_MAP[upper] || upper.toLowerCase();
  }
  throw new Error("coinId or symbol is required");
}

function r(n: number, dec = 2): number {
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
        await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 1500));
        continue;
      }
      throw err;
    }
  }
}

/* ────────────────────── execute ────────────────────── */

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
        throw new Error(`Unknown action: ${action}. Use: crypto_news, coin_sentiment, market_overview, social_stats, events`);
    }
  } catch (err: any) {
    return fail(err.message, (err as any).category || "unknown", start);
  }
}

/* ────────────────────── crypto_news ────────────────────── */

async function handleNews(args: any, start: number): Promise<string> {
  const limit = Math.min(Math.max(1, Number(args.limit) || 10), 30);
  const query = args.query?.toLowerCase() || "";

  const allArticles: Array<{
    title: string;
    link: string;
    source: string;
    pubDate: string;
    description: string;
  }> = [];

  // Fetch from multiple RSS sources in parallel
  const fetches = NEWS_SOURCES.map(async (source) => {
    try {
      const data = await fetchWithRetry(source.url);
      if (data?.items) {
        for (const item of data.items) {
          allArticles.push({
            title: item.title || "",
            link: item.link || "",
            source: source.name,
            pubDate: item.pubDate || "",
            description: stripHtml(item.description || "").slice(0, 200),
          });
        }
      }
    } catch {
      // Skip failed source
    }
  });

  await Promise.all(fetches);

  // Filter by query if provided
  let filtered = allArticles;
  if (query) {
    const terms = query.split(/\s+/);
    filtered = allArticles.filter((a) => {
      const text = `${a.title} ${a.description}`.toLowerCase();
      return terms.some((t: string) => text.includes(t));
    });
  }

  // Sort by date descending
  filtered.sort((a, b) => new Date(b.pubDate).getTime() - new Date(a.pubDate).getTime());
  filtered = filtered.slice(0, limit);

  return JSON.stringify({
    status: "ok",
    action: "crypto_news",
    query: query || undefined,
    count: filtered.length,
    articles: filtered,
    elapsedMs: Date.now() - start,
  });
}

/* ────────────────────── coin_sentiment ────────────────────── */

async function handleCoinSentiment(args: any, start: number): Promise<string> {
  const coinId = resolveCoinId(args);
  const currency = (args.currency || "usd").toLowerCase();

  // Fetch coin data + market data for sentiment signals
  const [coinData, fngData] = await Promise.all([
    fetchWithRetry(`${CG_BASE}/coins/${coinId}`, {
      localization: false,
      tickers: false,
      market_data: true,
      community_data: true,
      developer_data: true,
    }),
    fetchWithRetry("https://api.alternative.me/fng/?limit=1").catch(() => null),
  ]);

  const md = coinData.market_data;
  const community = coinData.community_data || {};
  const developer = coinData.developer_data || {};

  // Build sentiment signals
  const signals: Array<{ signal: string; value: any; interpretation: string }> = [];

  // Price momentum signals
  const change24h = md?.price_change_percentage_24h;
  const change7d = md?.price_change_percentage_7d;
  const change30d = md?.price_change_percentage_30d;

  if (change24h !== undefined) {
    signals.push({
      signal: "24h price change",
      value: r(change24h) + "%",
      interpretation: change24h > 5 ? "Strong bullish" : change24h > 0 ? "Bullish" : change24h > -5 ? "Bearish" : "Strong bearish",
    });
  }
  if (change7d !== undefined) {
    signals.push({
      signal: "7d price change",
      value: r(change7d) + "%",
      interpretation: change7d > 10 ? "Strong bullish momentum" : change7d > 0 ? "Positive trend" : change7d > -10 ? "Negative trend" : "Strong bearish momentum",
    });
  }

  // Volume signal
  if (md?.total_volume?.[currency] && md?.market_cap?.[currency]) {
    const volToMcap = md.total_volume[currency] / md.market_cap[currency];
    signals.push({
      signal: "Volume/MarketCap ratio",
      value: r(volToMcap, 4),
      interpretation: volToMcap > 0.3 ? "Very high activity (breakout/panic)" : volToMcap > 0.1 ? "Above average activity" : "Normal activity",
    });
  }

  // ATH distance
  if (md?.ath_change_percentage?.[currency]) {
    const athDist = md.ath_change_percentage[currency];
    signals.push({
      signal: "Distance from ATH",
      value: r(athDist) + "%",
      interpretation: athDist > -10 ? "Near ATH — caution" : athDist > -30 ? "Healthy range" : athDist > -60 ? "Significant discount" : "Deep discount from ATH",
    });
  }

  // Community signals
  if (community.twitter_followers) {
    signals.push({
      signal: "Twitter followers",
      value: community.twitter_followers,
      interpretation: community.twitter_followers > 1000000 ? "Major project" : community.twitter_followers > 100000 ? "Established project" : "Growing project",
    });
  }

  // Fear & Greed
  if (fngData?.data?.[0]) {
    const fng = fngData.data[0];
    signals.push({
      signal: "Fear & Greed Index",
      value: parseInt(fng.value, 10),
      interpretation: fng.value_classification,
    });
  }

  // Overall sentiment score (simple weighted average)
  let sentimentScore = 50; // neutral baseline
  if (change24h !== undefined) sentimentScore += Math.max(-20, Math.min(20, change24h * 2));
  if (change7d !== undefined) sentimentScore += Math.max(-15, Math.min(15, change7d));
  if (fngData?.data?.[0]) sentimentScore += (parseInt(fngData.data[0].value, 10) - 50) * 0.3;
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
      price: md?.current_price?.[currency],
      change24h: change24h ? r(change24h) : null,
      change7d: change7d ? r(change7d) : null,
      change30d: change30d ? r(change30d) : null,
      volume24h: md?.total_volume?.[currency],
      marketCap: md?.market_cap?.[currency],
    },
    elapsedMs: Date.now() - start,
  });
}

/* ────────────────────── market_overview ────────────────────── */

async function handleMarketOverview(args: any, start: number): Promise<string> {
  const [global, fng, trending] = await Promise.all([
    fetchWithRetry(`${CG_BASE}/global`),
    fetchWithRetry("https://api.alternative.me/fng/?limit=7").catch(() => null),
    fetchWithRetry(`${CG_BASE}/search/trending`).catch(() => null),
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

  // Market health assessment
  const marketCapChange = gd.market_cap_change_percentage_24h_usd || 0;
  let marketHealth: string;
  if (marketCapChange > 3) marketHealth = "Strong Rally";
  else if (marketCapChange > 0) marketHealth = "Positive";
  else if (marketCapChange > -3) marketHealth = "Slightly Negative";
  else marketHealth = "Selloff";

  return JSON.stringify({
    status: "ok",
    action: "market_overview",
    marketHealth,
    totalMarketCap: gd.total_market_cap?.usd ? r(gd.total_market_cap.usd) : null,
    totalVolume24h: gd.total_volume?.usd ? r(gd.total_volume.usd) : null,
    marketCapChange24h: r(marketCapChange),
    btcDominance: gd.market_cap_percentage?.btc ? r(gd.market_cap_percentage.btc, 1) : null,
    ethDominance: gd.market_cap_percentage?.eth ? r(gd.market_cap_percentage.eth, 1) : null,
    activeCryptos: gd.active_cryptocurrencies,
    fearGreed: fngCurrent ? {
      value: parseInt(fngCurrent.value, 10),
      label: fngCurrent.value_classification,
      trend: fngHistory,
    } : null,
    trending: trendingCoins,
    elapsedMs: Date.now() - start,
  });
}

/* ────────────────────── social_stats ────────────────────── */

async function handleSocialStats(args: any, start: number): Promise<string> {
  const coinId = resolveCoinId(args);

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
      twitterFollowers: community.twitter_followers,
      redditSubscribers: community.reddit_subscribers,
      redditActiveAccounts48h: community.reddit_accounts_active_48h,
      redditAvgPosts48h: community.reddit_average_posts_48h ? r(community.reddit_average_posts_48h) : null,
      redditAvgComments48h: community.reddit_average_comments_48h ? r(community.reddit_average_comments_48h) : null,
      telegramChannelMembers: community.telegram_channel_user_count,
    },
    developer: {
      forks: developer.forks,
      stars: developer.stars,
      subscribers: developer.subscribers,
      totalIssues: developer.total_issues,
      closedIssues: developer.closed_issues,
      pullRequestsMerged: developer.pull_requests_merged,
      pullRequestContributors: developer.pull_request_contributors,
      commitCount4Weeks: developer.commit_count_4_weeks,
    },
    links: {
      homepage: data.links?.homepage?.[0],
      github: data.links?.repos_url?.github?.[0],
      twitter: data.links?.twitter_screen_name ? `https://twitter.com/${data.links.twitter_screen_name}` : null,
      reddit: data.links?.subreddit_url,
      telegram: data.links?.telegram_channel_identifier ? `https://t.me/${data.links.telegram_channel_identifier}` : null,
    },
    elapsedMs: Date.now() - start,
  });
}

/* ────────────────────── events ────────────────────── */

async function handleEvents(args: any, start: number): Promise<string> {
  // CoinGecko events endpoint was deprecated, use status updates as alternative
  const coinId = args.coinId || args.symbol ? resolveCoinId(args) : null;

  if (coinId) {
    const data = await fetchWithRetry(`${CG_BASE}/coins/${coinId}/status_updates`, { per_page: 10 });
    const updates = (data?.status_updates || []).map((u: any) => ({
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

  // Global trending as events proxy
  const trending = await fetchWithRetry(`${CG_BASE}/search/trending`);
  const coins = (trending?.coins || []).map((item: any) => ({
    symbol: item.item?.symbol?.toUpperCase(),
    name: item.item?.name,
    rank: item.item?.market_cap_rank,
    note: "Trending on CoinGecko",
  }));

  return JSON.stringify({
    status: "ok",
    action: "events",
    note: "Showing trending coins as event proxy. Provide coinId for project-specific updates.",
    trending: coins,
    elapsedMs: Date.now() - start,
  });
}

/* ────────────────────── utility ────────────────────── */

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
}
