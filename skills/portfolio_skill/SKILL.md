# portfolio_skill
Purpose: Track paper/real trade positions with full P&L analytics (gross + net after fees), strategy attribution, and trade journaling.
Call name: "portfolio_skill"

## Actions

### open
Open a new position. Args:
{ action: "open", symbol: "BTC/USDT", side: "long", entryPrice: 65000, quantity: 0.1, stopLoss?: 63000, takeProfit?: 70000, exchange?: "binance", strategy?: "momentum", tags?: ["swing"], portfolioName?: "default" }
Validates SL/TP logic. Returns notional value, max loss, max profit, and risk/reward ratio.

### close
Close a position. Args: { action: "close", id: "abc123", exitPrice: 70000, portfolioName?: "default", feePercent?: 0.2, slippagePercent?: 0 }
Returns gross P&L, net P&L (after fees + slippage), total fees, win/loss result, and holding period.
Default feePercent is 0.2% (round-trip). Scoped to specified portfolio.

### update
Modify SL/TP on open position. Args: { action: "update", id: "abc123", stopLoss?: 64000, takeProfit?: 72000, portfolioName?: "default" }
Scoped to specified portfolio - prevents cross-portfolio edits.

### list
View positions with filtering, pagination, and sorting. Args:
{ action: "list", portfolioName?: "default", status?: "open", limit?: 50, offset?: 0, sortBy?: "openedAt", sortOrder?: "desc" }
Status: "open" (default), "closed", or "all". SortBy: openedAt, entryPrice, symbol, pnl, closedAt.

### history
View closed trades. Args: { action: "history", portfolioName?: "default", status?: "closed", limit?: 50, offset?: 0 }
Returns paginated results with total count for pagination.

### summary
Full portfolio analytics. Args: { action: "summary", portfolioName?: "default" }
Returns: win rate, total P&L (gross + net), total fees, profit factor, expectancy, avg win/loss, max win/loss streaks, largest win/loss, per-strategy breakdown with fees.

### delete
Remove a position. Args: { action: "delete", id: "abc123", portfolioName?: "default" }
Scoped to specified portfolio.

### note
Add a note to a position. Args: { action: "note", id: "abc123", note: "Moved SL to breakeven", portfolioName?: "default" }
Scoped to specified portfolio.

## Features
- Concurrency-safe atomic writes with backup on save
- JSON corruption detection with backup recovery (never silently resets)
- Collision-safe 12-hex-char IDs with uniqueness check
- Per-portfolio open position limit (500 per portfolio)
- Net P&L with configurable fees + slippage
- Per-strategy performance breakdown with fee tracking
- Pagination (limit + offset) and sorting for list/history
- Status filter on list and history (open/closed/all)
- Multiple named portfolios with cross-portfolio edit protection
- Trade journaling with notes (50 per position max)
- Win/loss streak tracking
- Profit factor and expectancy calculation

## Storage
config/portfolio.json (with config/portfolio.backup.json auto-backup)
