# portfolio_skill
Purpose: Track paper/real trade positions with full P&L analytics, strategy attribution, and trade journaling.
Call name: "portfolio_skill"

## Actions

### open
Open a new position. Args:
{ action: "open", symbol: "BTC/USDT", side: "long", entryPrice: 65000, quantity: 0.1, stopLoss?: 63000, takeProfit?: 70000, exchange?: "binance", strategy?: "momentum", tags?: ["swing"] }
Validates SL/TP logic (SL below entry for longs, above for shorts, etc.)
Returns notional value, max loss, max profit, and risk/reward ratio.

### close
Close a position. Args: { action: "close", id: "abc123", exitPrice: 70000 }
Returns P&L (absolute and %), win/loss result, and holding period.

### update
Modify SL/TP on open position. Args: { action: "update", id: "abc123", stopLoss?: 64000, takeProfit?: 72000 }

### list
View open positions. Args: { action: "list", portfolioName?: "default" }

### history
View closed trades. Args: { action: "history", portfolioName?: "default", limit?: 50 }

### summary
Full portfolio analytics. Args: { action: "summary", portfolioName?: "default" }
Returns: win rate, total P&L, profit factor, expectancy, avg win/loss, max win/loss streaks, largest win/loss, exposure, and per-strategy breakdown.

### delete
Remove a position. Args: { action: "delete", id: "abc123" }

### note
Add a note to a position. Args: { action: "note", id: "abc123", note: "Moved SL to breakeven after 5% move" }

## Features
- Concurrency-safe atomic writes
- Per-strategy performance breakdown
- Multiple named portfolios
- Trade journaling with notes
- Win/loss streak tracking
- Profit factor and expectancy calculation
- Max 500 open positions, 50 notes per position

## Storage
config/portfolio.json
