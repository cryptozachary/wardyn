# sentiment_skill
Purpose: Aggregate crypto news, compute sentiment scores from price/volume/Fear & Greed data, and fetch social stats. No API keys needed - uses CoinGecko + Alternative.me + RSS feeds.
Call name: "sentiment_skill"

## Actions

### crypto_news
Latest crypto news headlines. Args: { action: "crypto_news", query?: "bitcoin etf", limit?: 10 }
Returns headlines from CoinDesk and CoinTelegraph via RSS, with title, link, date, and source. Fetches RSS directly with rss2json proxy fallback.

### coin_sentiment
Sentiment score for a specific coin. Args: { action: "coin_sentiment", symbol: "BTC" }
Returns weighted sentiment score (0-100), label (Very Bearish to Very Bullish), and breakdown: 24h/7d price change, volume/mcap ratio, ATH distance, Fear & Greed Index.

### market_overview
Broad market sentiment snapshot. Args: { action: "market_overview" }
Returns global market stats, Fear & Greed current value + trend, and top trending coins. Results are TTL-cached to reduce rate-limit risk.

### social_stats
Social media activity for a coin. Args: { action: "social_stats", symbol: "BTC" }
Returns Twitter followers, Reddit subscribers, Telegram members, GitHub stars/forks/contributors, and developer activity scores from CoinGecko.

### events
Project status updates or trending coins. Args: { action: "events", symbol?: "BTC", limit?: 10 }
With coinId/symbol: returns project status updates (capped to limit). Without: returns trending coins as event proxy (capped to limit).

## No API keys needed
Uses CoinGecko free API, Alternative.me Fear & Greed, and direct RSS feeds (rss2json proxy as fallback).
