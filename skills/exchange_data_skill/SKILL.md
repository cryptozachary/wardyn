# exchange_data_skill
Purpose: Fetch live market data from CoinGecko (free, no API key) and Fear & Greed Index from Alternative.me. Covers tickers, orderbooks, OHLC candles, trending coins, global stats, categories, and exchange rankings.
Call name: "exchange_data_skill"

## Actions

### markets
Top coins by market cap. Args: { action: "markets", currency?: "usd", perPage?: 20, page?: 1, order?: "market_cap_desc", category?: "layer-1" }
Returns rank, symbol, price, 1h/24h/7d change, market cap, volume, ATH for each coin.

### ticker
Single coin details. Args: { action: "ticker", symbol: "BTC", currency?: "usd" }
Returns price, market cap, volume, 24h/7d/30d changes, ATH, supply info, top 10 exchange tickers.

### orderbook
Exchange-level bid/ask depth. Args: { action: "orderbook", symbol: "BTC", exchange?: "binance", depth?: 10 }
Returns ticker pairs up to requested depth with estimated bid/ask prices, spread, volume, and cost-to-move.

### trades
OHLC candle data. Args: { action: "trades", symbol: "BTC", currency?: "usd", days?: 7 }
Returns OHLC candles for the requested period. Valid days: 1, 7, 14, 30, 90, 180, 365.

### trending
Currently trending coins. Args: { action: "trending" }
Returns top trending coins and NFTs on CoinGecko by search popularity. Cached (5 min TTL).

### global
Global crypto market stats. Args: { action: "global" }
Returns total market cap, 24h volume, BTC/ETH dominance, active coins count. Cached (2 min TTL).

### categories
Coin categories with market data. Args: { action: "categories" }
Returns category names, market caps, 24h volume, and 24h change. Cached (5 min TTL).

### exchanges
Top exchanges by volume. Args: { action: "exchanges", perPage?: 20 }
Returns exchange name, trust score, 24h volume (BTC), year established, country.

### fear_greed
Crypto Fear & Greed Index. Args: { action: "fear_greed", limit?: 10 }
Returns index value (0-100), classification, trend, and historical data with interpretation. Cached (10 min TTL).

## No API keys needed
Uses CoinGecko free API and Alternative.me - no keys required. TTL caching reduces rate-limit risk.
