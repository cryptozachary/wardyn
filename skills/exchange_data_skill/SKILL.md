# exchange_data_skill
Purpose: Fetch live market data from CoinGecko (free, no API key) and Fear & Greed Index from Alternative.me. Covers tickers, orderbooks, trades, trending coins, global stats, categories, and exchange rankings.
Call name: "exchange_data_skill"

## Actions

### markets
Top coins by market cap. Args: { action: "markets", vs_currency?: "usd", per_page?: 50, page?: 1 }
Returns rank, symbol, price, 24h change, market cap, volume for each coin.

### ticker
Single coin details. Args: { action: "ticker", symbol: "BTC" }
Returns price, market cap, volume, 24h/7d/30d changes, ATH, ATL, supply info.

### orderbook
Simulated order book from tickers. Args: { action: "orderbook", symbol: "BTC", vs_currency?: "usd" }
Returns current price and exchange-level ticker data.

### trades
Recent trades / OHLC proxy. Args: { action: "trades", symbol: "BTC", vs_currency?: "usd", days?: 7 }
Returns OHLC data points for the requested period.

### trending
Currently trending coins. Args: { action: "trending" }
Returns top trending coins on CoinGecko by search popularity.

### global
Global crypto market stats. Args: { action: "global" }
Returns total market cap, 24h volume, BTC/ETH dominance, active coins count.

### categories
Coin categories with market data. Args: { action: "categories" }
Returns category names, market caps, 24h volume, and 24h change.

### exchanges
Top exchanges by volume. Args: { action: "exchanges", per_page?: 50 }
Returns exchange name, trust score, 24h volume, year established, country.

### fear_greed
Crypto Fear & Greed Index. Args: { action: "fear_greed", limit?: 7 }
Returns index value (0-100), label (Extreme Fear → Extreme Greed), and historical data.

## No API keys needed
Uses CoinGecko free API and Alternative.me — no keys required.
