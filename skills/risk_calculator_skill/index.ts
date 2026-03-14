export const parameters = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["position_size", "risk_reward", "stop_loss", "take_profit", "kelly", "breakeven", "liquidation", "compound"],
      description:
        "Calculation: position_size (how much to buy), risk_reward (R:R analysis), stop_loss (optimal SL placement), take_profit (TP targets), kelly (Kelly criterion sizing), breakeven (breakeven price after fees), liquidation (estimated liquidation price), compound (compound growth projection).",
    },

    // Common inputs
    accountSize: { type: "number", description: "Total account value in quote currency (e.g. USDT)" },
    riskPercent: { type: "number", description: "Max risk per trade as % of account (e.g. 2 for 2%)" },
    entryPrice: { type: "number", description: "Planned entry price" },
    stopLoss: { type: "number", description: "Stop loss price" },
    takeProfit: { type: "number", description: "Take profit price" },
    side: { type: "string", enum: ["long", "short"], description: "Trade direction (default: long)" },

    // Position size extras
    leverage: { type: "number", description: "Leverage multiplier (default: 1 for spot)" },
    feePercent: { type: "number", description: "Trading fee as % (e.g. 0.1 for 0.1%)" },

    // Kelly criterion
    winRate: { type: "number", description: "Historical win rate as decimal (e.g. 0.55 for 55%)" },
    avgWin: { type: "number", description: "Average win amount" },
    avgLoss: { type: "number", description: "Average loss amount" },
    kellyFraction: { type: "number", description: "Kelly fraction to use (default: 0.5 for half-Kelly)" },

    // Multi-target TP
    targets: {
      type: "array",
      items: {
        type: "object",
        properties: {
          price: { type: "number", description: "Target price" },
          percent: { type: "number", description: "Percentage of position to close at this target" },
        },
        required: ["price", "percent"],
      },
      description: "Take profit targets: [{ price: 70000, percent: 50 }, { price: 75000, percent: 50 }]",
    },

    // Liquidation
    maintenanceMargin: { type: "number", description: "Maintenance margin rate as decimal (default: 0.005 for 0.5%)" },

    // Compound
    startingCapital: { type: "number", description: "Starting capital for compound projection" },
    returnPercent: { type: "number", description: "Expected return per trade as % (can be negative for drawdown modeling)" },
    trades: { type: "number", description: "Number of trades to project" },
    reinvestPercent: { type: "number", description: "Percent of profits to reinvest (default: 100)" },

    // Stop loss extras
    quantity: { type: "number", description: "Position size for fixed-risk stop loss calculation" },
  },
  required: ["action"],
};

/* ------------------------------------------------------------------ */
/*  Execute                                                           */
/* ------------------------------------------------------------------ */

export async function execute(args: any): Promise<string> {
  const start = Date.now();
  const { action } = args;

  try {
    switch (action) {
      case "position_size": return positionSize(args, start);
      case "risk_reward": return riskReward(args, start);
      case "stop_loss": return stopLossCalc(args, start);
      case "take_profit": return takeProfitCalc(args, start);
      case "kelly": return kellyCalc(args, start);
      case "breakeven": return breakevenCalc(args, start);
      case "liquidation": return liquidationCalc(args, start);
      case "compound": return compoundCalc(args, start);
      default:
        throw new Error(`Unknown action: ${action}. Use: position_size, risk_reward, stop_loss, take_profit, kelly, breakeven, liquidation, compound`);
    }
  } catch (err: any) {
    return JSON.stringify({ status: "error", action, error: err.message, elapsedMs: Date.now() - start });
  }
}

/* ------------------------------------------------------------------ */
/*  position_size (fix #1: correct leverage math)                     */
/* ------------------------------------------------------------------ */

function positionSize(args: any, start: number): string {
  const { accountSize, entryPrice, stopLoss } = args;
  const riskPercent = requirePositiveNum(args.riskPercent, "riskPercent");
  const leverage = requireInRange(args.leverage ?? 1, "leverage", 1, 125);
  const feePercent = requireNonNegative(args.feePercent ?? 0.1, "feePercent");
  const side = args.side || "long";

  requirePositive({ accountSize, entryPrice, stopLoss });
  validateSide(side, entryPrice, stopLoss, undefined, "stopLoss");

  const riskAmount = accountSize * (riskPercent / 100);
  const stopDistance = Math.abs(entryPrice - stopLoss);
  if (stopDistance === 0) throw new Error("entryPrice and stopLoss cannot be the same");

  const stopPercent = (stopDistance / entryPrice) * 100;
  const feePerTrade = feePercent / 100;
  const roundTripFeePercent = feePerTrade * 2;

  // With leverage: fees apply to the leveraged notional, risk applies to margin
  // Effective risk per unit = (stopPercent/100) + (roundTripFeePercent * leverage)
  // But risk is measured against margin (notional / leverage)
  // riskAmount = margin * (stopPercent/100 * leverage + roundTripFeePercent * leverage)
  // riskAmount = margin * leverage * (stopPercent/100 + roundTripFeePercent)
  // margin = riskAmount / (leverage * (stopPercent/100 + roundTripFeePercent))
  const effectiveRiskRate = (stopPercent / 100) + roundTripFeePercent;
  const marginRequired = riskAmount / (leverage * effectiveRiskRate);
  const leveragedValue = marginRequired * leverage;
  const quantity = leveragedValue / entryPrice;
  const estimatedFees = leveragedValue * roundTripFeePercent;

  const warnings: string[] = [];
  if (marginRequired > accountSize) warnings.push("Margin required exceeds account size");
  if (estimatedFees > riskAmount * 0.3) warnings.push("Fees consume >30% of risk budget");

  return JSON.stringify({
    status: "ok",
    action: "position_size",
    side,
    entryPrice,
    stopLoss,
    accountSize,
    riskPercent,
    riskAmount: r(riskAmount),
    stopDistance: r(stopDistance),
    stopPercent: r(stopPercent),
    quantity: r(quantity, 6),
    positionValue: r(leveragedValue),
    leverage,
    marginRequired: r(marginRequired),
    estimatedFees: r(estimatedFees),
    ...(warnings.length > 0 && { warnings }),
    elapsedMs: Date.now() - start,
  });
}

/* ------------------------------------------------------------------ */
/*  risk_reward (fix #2: side-aware validation + #5: guardrails)      */
/* ------------------------------------------------------------------ */

function riskReward(args: any, start: number): string {
  const { entryPrice, stopLoss, takeProfit } = args;
  const side = args.side || "long";
  const feePercent = requireNonNegative(args.feePercent ?? 0.1, "feePercent");

  requirePositive({ entryPrice, stopLoss, takeProfit });
  validateSide(side, entryPrice, stopLoss, takeProfit, "stopLoss");

  const risk = Math.abs(entryPrice - stopLoss);
  const reward = Math.abs(takeProfit - entryPrice);
  if (risk === 0) throw new Error("entryPrice and stopLoss cannot be the same");

  const ratio = reward / risk;
  const riskPercent = (risk / entryPrice) * 100;
  const rewardPercent = (reward / entryPrice) * 100;
  const totalFeePct = (feePercent / 100) * 2 * 100; // round-trip in percent
  const netRewardPercent = rewardPercent - totalFeePct;
  const netRiskPercent = riskPercent + totalFeePct;
  const netRatio = netRiskPercent > 0 ? netRewardPercent / netRiskPercent : 0;

  // Required win rate to be profitable at this R:R
  const requiredWinRate = 1 / (1 + ratio);

  // Grade the trade
  let grade: string;
  if (ratio >= 3) grade = "A - Excellent";
  else if (ratio >= 2) grade = "B - Good";
  else if (ratio >= 1.5) grade = "C - Acceptable";
  else if (ratio >= 1) grade = "D - Marginal";
  else grade = "F - Poor (risk > reward)";

  const warnings: string[] = [];
  if (netRatio <= 0) warnings.push("Net R:R is negative after fees - this trade loses money even on a win");
  if (netRewardPercent <= 0) warnings.push("Fees exceed potential reward");

  return JSON.stringify({
    status: "ok",
    action: "risk_reward",
    side,
    entryPrice,
    stopLoss,
    takeProfit,
    risk: r(risk),
    reward: r(reward),
    ratio: r(ratio, 2),
    riskPercent: r(riskPercent),
    rewardPercent: r(rewardPercent),
    netRatio: r(Math.max(0, netRatio), 2),
    requiredWinRate: r(requiredWinRate * 100, 1),
    grade,
    ...(warnings.length > 0 && { warnings }),
    elapsedMs: Date.now() - start,
  });
}

/* ------------------------------------------------------------------ */
/*  stop_loss (fix #3: validate optional numeric inputs)              */
/* ------------------------------------------------------------------ */

function stopLossCalc(args: any, start: number): string {
  const { entryPrice } = args;
  const side = args.side || "long";

  requirePositive({ entryPrice });

  const results: any = { status: "ok", action: "stop_loss", side, entryPrice };

  // Method 1: Percentage-based
  if (args.riskPercent !== undefined) {
    const riskPct = requirePositiveNum(args.riskPercent, "riskPercent");
    const slDistance = entryPrice * (riskPct / 100);
    results.percentageBased = {
      riskPercent: riskPct,
      stopLoss: r(side === "long" ? entryPrice - slDistance : entryPrice + slDistance),
      distance: r(slDistance),
    };
  }

  // Method 2: Fixed dollar risk
  if (args.accountSize !== undefined && args.riskPercent !== undefined && args.quantity !== undefined) {
    const accSize = requirePositiveNum(args.accountSize, "accountSize");
    const riskPct = requirePositiveNum(args.riskPercent, "riskPercent");
    const qty = requirePositiveNum(args.quantity, "quantity");
    const maxRisk = accSize * (riskPct / 100);
    const slDistance = maxRisk / qty;
    results.fixedRisk = {
      maxRiskAmount: r(maxRisk),
      stopLoss: r(side === "long" ? entryPrice - slDistance : entryPrice + slDistance),
      distance: r(slDistance),
    };
  }

  // Method 3: ATR-based suggestions (common multipliers)
  results.atrSuggestions = {
    note: "Use the TAAPI skill to get ATR, then multiply by these factors:",
    conservative: "1.5x ATR",
    moderate: "2.0x ATR",
    wide: "3.0x ATR",
    formula: side === "long" ? "SL = entry - (ATR x multiplier)" : "SL = entry + (ATR x multiplier)",
  };

  results.elapsedMs = Date.now() - start;
  return JSON.stringify(results);
}

/* ------------------------------------------------------------------ */
/*  take_profit (fix #2: side-aware + #6: strict targets)             */
/* ------------------------------------------------------------------ */

function takeProfitCalc(args: any, start: number): string {
  const { entryPrice, stopLoss, targets } = args;
  const side = args.side || "long";

  requirePositive({ entryPrice });

  const results: any = { status: "ok", action: "take_profit", side, entryPrice };

  // R-multiple targets (with side-aware SL validation)
  if (stopLoss !== undefined) {
    requirePositiveNum(stopLoss, "stopLoss");
    validateSide(side, entryPrice, stopLoss, undefined, "stopLoss");
    const risk = Math.abs(entryPrice - stopLoss);
    results.rMultipleTargets = [1, 1.5, 2, 3, 5].map((mult) => ({
      rMultiple: mult,
      price: r(side === "long" ? entryPrice + risk * mult : entryPrice - risk * mult),
      rewardPercent: r((risk * mult / entryPrice) * 100),
    }));
  }

  // Percentage targets
  results.percentTargets = [1, 2, 3, 5, 10].map((pct) => ({
    percent: pct,
    price: r(side === "long" ? entryPrice * (1 + pct / 100) : entryPrice * (1 - pct / 100)),
  }));

  // Multi-target analysis (fix #6: strict validation)
  if (targets !== undefined) {
    if (!Array.isArray(targets) || targets.length === 0) {
      throw new Error("targets must be a non-empty array of { price: number, percent: number }");
    }

    let totalPercent = 0;
    const validated = targets.map((t: any, i: number) => {
      if (typeof t.price !== "number" || t.price <= 0) {
        throw new Error(`targets[${i}].price must be a positive number`);
      }
      if (typeof t.percent !== "number" || t.percent <= 0 || t.percent > 100) {
        throw new Error(`targets[${i}].percent must be between 0 and 100`);
      }
      // Validate target direction
      if (side === "long" && t.price <= entryPrice) {
        throw new Error(`targets[${i}].price (${t.price}) must be above entry (${entryPrice}) for long`);
      }
      if (side === "short" && t.price >= entryPrice) {
        throw new Error(`targets[${i}].price (${t.price}) must be below entry (${entryPrice}) for short`);
      }
      totalPercent += t.percent;
      const distance = Math.abs(t.price - entryPrice);
      return {
        price: t.price,
        closePercent: t.percent,
        profitPercent: r((distance / entryPrice) * 100),
      };
    });

    results.multiTarget = validated;

    // Tolerance: allow 99-101% for floating point
    if (totalPercent < 99 || totalPercent > 101) {
      results.multiTargetWarning = `Target percentages sum to ${r(totalPercent, 1)}%, should be ~100%`;
    }
  }

  results.elapsedMs = Date.now() - start;
  return JSON.stringify(results);
}

/* ------------------------------------------------------------------ */
/*  kelly                                                             */
/* ------------------------------------------------------------------ */

function kellyCalc(args: any, start: number): string {
  const { winRate, avgWin, avgLoss, accountSize, kellyFraction = 0.5 } = args;

  if (!winRate || winRate <= 0 || winRate >= 1) throw new Error("winRate must be between 0 and 1 (e.g. 0.55 for 55%)");
  requirePositive({ avgWin, avgLoss });
  if (kellyFraction <= 0 || kellyFraction > 1) throw new Error("kellyFraction must be between 0 and 1");

  const b = avgWin / avgLoss; // win/loss ratio
  const q = 1 - winRate;

  // Kelly formula: f* = (bp - q) / b
  const fullKelly = (b * winRate - q) / b;
  const fractionalKelly = fullKelly * kellyFraction;

  const results: any = {
    status: "ok",
    action: "kelly",
    winRate: r(winRate * 100, 1),
    avgWin: r(avgWin),
    avgLoss: r(avgLoss),
    winLossRatio: r(b, 2),
    fullKellyPercent: r(fullKelly * 100, 2),
    fractionalKellyPercent: r(fractionalKelly * 100, 2),
    kellyFraction,
    recommendation: fullKelly <= 0
      ? "Negative edge - do not trade this strategy"
      : `Risk ${r(fractionalKelly * 100, 1)}% of account per trade (${kellyFraction === 0.5 ? "half" : r(kellyFraction * 100)}% Kelly)`,
  };

  if (accountSize && accountSize > 0) {
    results.riskAmount = r(accountSize * Math.max(0, fractionalKelly));
  }

  // Edge and expected value
  results.edge = r(winRate * avgWin - q * avgLoss, 2);
  results.expectedValuePerTrade = results.edge;

  results.elapsedMs = Date.now() - start;
  return JSON.stringify(results);
}

/* ------------------------------------------------------------------ */
/*  breakeven (fix #4: correct leverage logic)                        */
/* ------------------------------------------------------------------ */

function breakevenCalc(args: any, start: number): string {
  const { entryPrice } = args;
  const feePercent = requireNonNegative(args.feePercent ?? 0.1, "feePercent");
  const leverage = requireInRange(args.leverage ?? 1, "leverage", 1, 125);
  const side = args.side || "long";

  requirePositive({ entryPrice });

  // Round-trip fee rate (entry + exit)
  const roundTripFeeRate = (feePercent / 100) * 2;

  // Spot breakeven: price must move by totalFees to cover costs
  // Fee is charged on leveraged notional, but P&L is also on leveraged notional
  // So breakeven move % = roundTripFeeRate (same regardless of leverage)
  // The fee dollar amount scales with leverage, but so does the P&L per price move
  const breakevenMovePercent = roundTripFeeRate * 100;
  const breakevenDistance = entryPrice * roundTripFeeRate;

  const breakevenPrice = side === "long"
    ? entryPrice + breakevenDistance
    : entryPrice - breakevenDistance;

  // With leverage: the actual dollar fee is higher
  const feeDollarsPerUnit = entryPrice * roundTripFeeRate * leverage;

  return JSON.stringify({
    status: "ok",
    action: "breakeven",
    side,
    entryPrice,
    feePercent,
    leverage,
    roundTripFeePercent: r(roundTripFeeRate * 100, 3),
    breakevenPrice: r(breakevenPrice),
    breakevenDistance: r(breakevenDistance),
    breakevenMovePercent: r(breakevenMovePercent, 3),
    ...(leverage > 1 && {
      note: `With ${leverage}x leverage, you pay ${r(roundTripFeeRate * leverage * 100, 3)}% of margin in fees, but breakeven price move remains ${r(breakevenMovePercent, 3)}%`,
      feeAsPercentOfMargin: r(roundTripFeeRate * leverage * 100, 3),
    }),
    elapsedMs: Date.now() - start,
  });
}

/* ------------------------------------------------------------------ */
/*  liquidation (fix #5: guardrails)                                  */
/* ------------------------------------------------------------------ */

function liquidationCalc(args: any, start: number): string {
  const { entryPrice, leverage, maintenanceMargin = 0.005 } = args;
  const side = args.side || "long";

  requirePositive({ entryPrice, leverage });
  if (leverage < 1) throw new Error("leverage must be >= 1");
  requireNonNegative(maintenanceMargin, "maintenanceMargin");

  // Liquidation price formula:
  // Long: entryPrice * (1 - 1/leverage + maintenanceMargin)
  // Short: entryPrice * (1 + 1/leverage - maintenanceMargin)
  const liqPrice = side === "long"
    ? entryPrice * (1 - (1 / leverage) + maintenanceMargin)
    : entryPrice * (1 + (1 / leverage) - maintenanceMargin);

  const distancePercent = Math.abs(entryPrice - liqPrice) / entryPrice * 100;

  // Guardrail: check if SL is provided and compare
  const warnings: string[] = [];
  if (distancePercent < 5) warnings.push("Liquidation is very close to entry - high risk");
  if (liqPrice <= 0 && side === "long") warnings.push("Liquidation price is zero or negative - check leverage/margin inputs");

  // Check if stop loss is beyond liquidation
  if (args.stopLoss !== undefined) {
    const sl = args.stopLoss;
    if (side === "long" && sl <= liqPrice) {
      warnings.push(`Stop loss (${sl}) is at or beyond liquidation price (${r(liqPrice)}) - stop will never trigger`);
    }
    if (side === "short" && sl >= liqPrice) {
      warnings.push(`Stop loss (${sl}) is at or beyond liquidation price (${r(liqPrice)}) - stop will never trigger`);
    }
  }

  return JSON.stringify({
    status: "ok",
    action: "liquidation",
    side,
    entryPrice,
    leverage,
    maintenanceMargin: r(maintenanceMargin * 100, 2),
    liquidationPrice: r(liqPrice),
    distanceToLiquidation: r(distancePercent, 2),
    ...(warnings.length > 0 && { warnings }),
    elapsedMs: Date.now() - start,
  });
}

/* ------------------------------------------------------------------ */
/*  compound (fix #7: negative returns supported)                     */
/* ------------------------------------------------------------------ */

function compoundCalc(args: any, start: number): string {
  const { startingCapital, returnPercent, trades, reinvestPercent = 100 } = args;

  requirePositive({ startingCapital });
  if (typeof returnPercent !== "number") throw new Error("returnPercent is required");
  if (returnPercent === 0) throw new Error("returnPercent cannot be zero");
  if (returnPercent < -100) throw new Error("returnPercent cannot be less than -100%");
  if (typeof trades !== "number" || trades < 1 || !Number.isInteger(trades)) throw new Error("trades must be a positive integer");
  if (trades > 1000) throw new Error("trades max is 1000");

  const reinvestFraction = Math.min(100, Math.max(0, reinvestPercent)) / 100;
  let capital = startingCapital;
  let peakCapital = startingCapital;
  let maxDrawdown = 0;
  let ruinTrade: number | null = null;
  const milestones: Array<{ trade: number; capital: number; totalReturn: number; drawdown?: number }> = [];

  for (let i = 1; i <= trades; i++) {
    const profit = capital * (returnPercent / 100);

    if (returnPercent > 0) {
      // Positive return: reinvest fraction of profits
      capital += profit * reinvestFraction;
    } else {
      // Negative return: full loss applies (drawdown modeling)
      capital += profit;
    }

    // Track drawdown from peak
    if (capital > peakCapital) peakCapital = capital;
    const currentDrawdown = peakCapital > 0 ? ((peakCapital - capital) / peakCapital) * 100 : 0;
    if (currentDrawdown > maxDrawdown) maxDrawdown = currentDrawdown;

    // Detect ruin (capital <= 0)
    if (capital <= 0 && ruinTrade === null) {
      ruinTrade = i;
      capital = 0;
    }

    // Record milestones
    if (i <= 5 || i % 10 === 0 || i === trades || i === ruinTrade) {
      milestones.push({
        trade: i,
        capital: r(capital, 2),
        totalReturn: r(((capital - startingCapital) / startingCapital) * 100, 2),
        ...(returnPercent < 0 && { drawdown: r(currentDrawdown, 2) }),
      });
    }

    if (capital <= 0) break;
  }

  const warnings: string[] = [];
  if (ruinTrade !== null) warnings.push(`Account reaches zero at trade #${ruinTrade}`);
  if (returnPercent < 0) warnings.push("Modeling drawdown scenario (negative returns)");

  return JSON.stringify({
    status: "ok",
    action: "compound",
    startingCapital,
    returnPercent,
    trades,
    reinvestPercent,
    finalCapital: r(capital, 2),
    totalProfit: r(capital - startingCapital, 2),
    totalReturnPercent: r(((capital - startingCapital) / startingCapital) * 100, 2),
    multiplier: r(capital / startingCapital, 2),
    ...(returnPercent < 0 && { maxDrawdownPercent: r(maxDrawdown, 2) }),
    ...(ruinTrade !== null && { ruinAtTrade: ruinTrade }),
    milestones,
    ...(warnings.length > 0 && { warnings }),
    elapsedMs: Date.now() - start,
  });
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function r(n: number, decimals = 4): number {
  return Math.round(n * Math.pow(10, decimals)) / Math.pow(10, decimals);
}

function requirePositive(fields: Record<string, any>): void {
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined || value === null) throw new Error(`${name} is required`);
    if (typeof value !== "number" || value <= 0) throw new Error(`${name} must be a positive number`);
  }
}

/** Validate a single number is positive, return it */
function requirePositiveNum(value: any, name: string): number {
  if (value === undefined || value === null) throw new Error(`${name} is required`);
  if (typeof value !== "number" || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
}

/** Validate a number is >= 0, return it */
function requireNonNegative(value: any, name: string): number {
  if (typeof value !== "number" || value < 0) throw new Error(`${name} must be a non-negative number`);
  return value;
}

/** Validate a number is within a range, return it */
function requireInRange(value: any, name: string, min: number, max: number): number {
  if (typeof value !== "number" || value < min || value > max) {
    throw new Error(`${name} must be between ${min} and ${max}`);
  }
  return value;
}

/** Side-aware SL/TP validation */
function validateSide(
  side: string,
  entryPrice: number,
  stopLoss?: number,
  takeProfit?: number,
  _label?: string,
): void {
  if (stopLoss !== undefined) {
    if (side === "long" && stopLoss >= entryPrice) {
      throw new Error("For long: stopLoss must be below entryPrice");
    }
    if (side === "short" && stopLoss <= entryPrice) {
      throw new Error("For short: stopLoss must be above entryPrice");
    }
  }
  if (takeProfit !== undefined) {
    if (side === "long" && takeProfit <= entryPrice) {
      throw new Error("For long: takeProfit must be above entryPrice");
    }
    if (side === "short" && takeProfit >= entryPrice) {
      throw new Error("For short: takeProfit must be below entryPrice");
    }
  }
}
