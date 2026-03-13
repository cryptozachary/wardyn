# taapi_io_price_retriever_skill
Purpose: Full TAAPI.io integration — price data, 200+ technical indicators, OHLCV candles, and bulk multi-indicator queries for autonomous crypto/stock research.
Call name: "taapi_io_price_retriever_skill"

## Actions

### price (default)
Get current or historical price. Args: { action: "price", symbol: "BTC/USDT", interval?: "1d", exchange?: "binance" }

### indicator
Get any technical indicator (RSI, MACD, EMA, Bollinger Bands, etc.). Args: { action: "indicator", symbol: "BTC/USDT", indicator: "rsi", period?: 14, chart?: "heikinashi", indicatorParams?: { optInFastPeriod: 12 } }
Common indicators: rsi, macd, ema, sma, bbands, stochrsi, adx, atr, obv, vwap, supertrend, ichimoku, stoch, cci, mfi, psar, volume, pivotpoints, doji, hammer, engulfing, morningstar
Full list: 200+ indicators at taapi.io/indicators

### candle
Get OHLCV data (open/high/low/close/volume). Args: { action: "candle", symbol: "BTC/USDT", backtrack?: 5 }

### bulk
Get multiple indicators in ONE request (max 20, counts as 1 API call). Args:
{ action: "bulk", symbol: "BTC/USDT", indicators: [
  { indicator: "rsi", period: 14 },
  { indicator: "macd", id: "my_macd" },
  { indicator: "ema", period: 20, backtrack: 5 }
]}
Each indicator can have: indicator, period, backtrack, results, addResultTimestamp, chart, id, params (extra key-values).
Calculation limit: total (indicators × backtracks) must be <= 20 per request.

## Common parameters
- symbol: Required. BTC/USDT (crypto) or AAPL (stocks). Auto-normalizes BTCUSDT → BTC/USDT.
- assetType (or type): "crypto" (default) or "stocks"
- exchange: binance (default), binancefutures, bitstamp, coinbase, kraken, kucoin, bybit, okx, bitfinex, gemini, gateio, whitebit
- interval: 1m, 5m, 15m, 30m, 1h, 2h, 4h, 12h, 1d (default), 1w
- chart: "candles" (default) or "heikinashi" (Pro/Expert plans)

## Historical options
- backtrack: candles back from latest (max 50)
- results: number or "max"
- fromTimestamp / toTimestamp: UNIX seconds
- fromDate / toDate: ISO date strings
- addResultTimestamp: include timestamps
- Use either date range OR backtrack/results, not both

## Research examples
- "What's the RSI for ETH?" → { action: "indicator", symbol: "ETH/USDT", indicator: "rsi" }
- "Full technical analysis of BTC" → { action: "bulk", symbol: "BTC/USDT", indicators: [{ indicator: "rsi" }, { indicator: "macd" }, { indicator: "bbands" }, { indicator: "adx" }, { indicator: "atr" }, { indicator: "obv" }, { indicator: "stochrsi" }] }
- "BTC price history last 10 candles" → { action: "price", symbol: "BTC/USDT", backtrack: 10, addResultTimestamp: true }
- "Is there a doji pattern on SOL?" → { action: "indicator", symbol: "SOL/USDT", indicator: "doji" }

## Security
- Retry: transient failures (429, 5xx, network) retried up to 2x with exponential backoff
- Error categories: invalid_api_key, bad_symbol, rate_limited, bad_interval, bad_exchange, bad_indicator, no_data, network, server, validation
- Secrets: TAAPI_API_KEY (configure in Setup > Skill Secrets)
