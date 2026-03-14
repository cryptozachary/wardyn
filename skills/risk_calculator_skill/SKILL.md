# risk_calculator_skill
Purpose: Calculate position sizing, risk/reward, stop losses, take profits, Kelly criterion, breakeven, liquidation prices, and compound growth projections. No API needed - pure math.
Call name: "risk_calculator_skill"

## Actions

### position_size
How much to buy. Args: { action: "position_size", accountSize: 10000, riskPercent: 2, entryPrice: 65000, stopLoss: 63000, leverage?: 1, feePercent?: 0.1, side?: "long" }
Returns quantity, position value, margin required, estimated fees. Leverage math correctly accounts for fees on leveraged notional. Side-aware SL validation.

### risk_reward
Analyze trade quality. Args: { action: "risk_reward", entryPrice: 65000, stopLoss: 63000, takeProfit: 70000, side?: "long", feePercent?: 0.1 }
Returns R:R ratio, net ratio (after fees), required win rate, and letter grade (A-F). Side-aware: validates SL/TP direction. Warns if net R:R is negative after fees.

### stop_loss
Optimal stop placement. Args: { action: "stop_loss", entryPrice: 65000, riskPercent?: 2, accountSize?: 10000, quantity?: 0.1, side?: "long" }
Returns percentage-based SL, fixed-risk SL, and ATR-based suggestions. All optional numeric inputs are strictly validated.

### take_profit
Target calculation. Args: { action: "take_profit", entryPrice: 65000, stopLoss?: 63000, targets?: [{ price: 70000, percent: 50 }, { price: 75000, percent: 50 }], side?: "long" }
Returns R-multiple targets (1R, 1.5R, 2R, 3R, 5R), percentage targets, and multi-target analysis. Targets validated: requires { price: number, percent: number }, percent must sum to ~100%, prices must be in correct direction for side.

### kelly
Kelly criterion position sizing. Args: { action: "kelly", winRate: 0.55, avgWin: 500, avgLoss: 300, accountSize?: 10000, kellyFraction?: 0.5 }
Returns full/fractional Kelly %, recommended risk amount, edge, and expected value per trade.

### breakeven
Breakeven after fees. Args: { action: "breakeven", entryPrice: 65000, feePercent?: 0.1, leverage?: 1, side?: "long" }
Returns breakeven price accounting for round-trip fees. Correctly explains that breakeven price move % is independent of leverage (fees and P&L both scale with leverage).

### liquidation
Estimated liquidation price. Args: { action: "liquidation", entryPrice: 65000, leverage: 10, maintenanceMargin?: 0.005, side?: "long", stopLoss?: 63000 }
Returns liquidation price and distance percentage. Warns if liquidation is < 5% from entry, if liq price is invalid, or if stop loss is beyond liquidation.

### compound
Compound growth projection. Args: { action: "compound", startingCapital: 10000, returnPercent: 2, trades: 100, reinvestPercent?: 100 }
Supports negative returnPercent for drawdown modeling. Returns final capital, total return, multiplier, milestones, max drawdown (for losses), and ruin detection (when capital hits zero).

## No API keys needed
All calculations are pure math - works offline, zero latency, no rate limits.
