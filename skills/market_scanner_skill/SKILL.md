# market_scanner_skill
Purpose: Scan multiple crypto/stock symbols against technical strategies to find trade opportunities. Uses TAAPI bulk endpoint for efficient multi-indicator fetching.
Call name: "market_scanner_skill"

## Actions

### scan
Run a strategy against a watchlist. Args:
{ action: "scan", strategy: "oversold", symbols?: ["BTC/USDT", "ETH/USDT"], exchange?: "binance", interval?: "1d", maxResults?: 20, sortBy?: "rsi", sortOrder?: "asc" }
If symbols is omitted, uses the saved watchlist.

### watchlist
View current watchlist. Args: { action: "watchlist", watchlistName?: "default" }

### add_watchlist
Add symbols to a watchlist. Args: { action: "add_watchlist", symbols: ["SOL/USDT", "AVAX/USDT"], watchlistName?: "default" }

### remove_watchlist
Remove symbols. Args: { action: "remove_watchlist", symbols: ["DOGE/USDT"], watchlistName?: "default" }

### presets
List all built-in strategies. Args: { action: "presets" }

## Built-in strategies
- **oversold**: RSI < 35 — bounce candidates. Sorted by lowest RSI.
- **overbought**: RSI > 65 — short/exit candidates. Sorted by highest RSI.
- **macd_cross**: MACD histogram crossing zero — bullish/bearish signal.
- **volume_spike**: Volume > 1.5x 20-period average — potential breakout.
- **bollinger_squeeze**: Bollinger Band width < 0.1 — consolidation before breakout.
- **momentum**: RSI 50-70 + MACD bullish + ADX > 25 — strong upward trend.
- **trend_reversal**: Oversold RSI + bullish MACD cross + volume above average.
- **full_analysis**: Returns all key indicators for every symbol (no filter).

## Custom expressions
Use custom filter strings: "rsi < 30 AND macd_hist > 0 AND adx > 25"
Supported operators: >, <, >=, <=, ==, !=. Join conditions with AND.

## Default watchlist
Top 20 crypto by market cap: BTC, ETH, SOL, BNB, XRP, ADA, AVAX, DOGE, DOT, MATIC, LINK, UNI, ATOM, LTC, NEAR, APT, OP, ARB, FIL, INJ (all /USDT pairs).

## Limits
- Max 50 symbols per scan, 100 per watchlist
- 60s total scan timeout
- Uses TAAPI bulk endpoint (1 API call per symbol)
- Watchlists persist to config/watchlists.json

## Returns
{ status, action, strategy, matchCount, scanned, matches: [{ symbol, score, indicators: {...} }], elapsedMs }
