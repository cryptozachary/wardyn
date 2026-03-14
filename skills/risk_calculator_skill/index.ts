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
      items: { type: "object" },
      description: "Take profit targets: [{ price: 70000, percent: 50 }, { price: 75000, percent: 50 }]",
    },

    // Liquidation
    maintenanceMargin: { type: "number", description: "Maintenance margin rate as decimal (default: 0.005 for 0.5%)" },

    // Compound
    startingCapital: { type: "number", description: "Starting capital for compound projection" },
    returnPercent: { type: "number", description: "Expected return per trade as %" },
    trades: { type: "number", description: "Number of trades to project" },
    reinvestPercent: { type: "number", description: "Percent of profits to reinvest (default: 100)" },
  },
  required: ["action"],
};

/* ────────────────────── execute ────────────────────── */

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

/* ────────────────────── calculations ────────────────────── */

function positionSize(args: any, start: number): string {
  const { accountSize, riskPercent, entryPrice, stopLoss, leverage = 1, feePercent = 0.1 } = args;
  const side = args.side || "long";

  requirePositive({ accountSize, riskPercent, entryPrice, stopLoss });
  if (leverage < 1 || leverage > 125) throw new Error("leverage must be 1-125");

  const riskAmount = accountSize * (riskPercent / 100);
  const stopDistance = Math.abs(entryPrice - stopLoss);
  if (stopDistance === 0) throw new Error("entryPrice and stopLoss cannot be the same");

  const stopPercent = (stopDistance / entryPrice) * 100;
  const feePerTrade = feePercent / 100;
  const totalFeePercent = feePerTrade * 2; // entry + exit

  // Position size accounting for fees
  const effectiveStopPercent = stopPercent + (totalFeePercent * 100);
  const positionValue = riskAmount / (effectiveStopPercent / 100);
  const quantity = positionValue / entryPrice;
  const leveragedQuantity = quantity * leverage;
  const leveragedValue = leveragedQuantity * entryPrice;
  const marginRequired = leveragedValue / leverage;

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
    positionValue: r(positionValue),
    leverage,
    leveragedQuantity: r(leveragedQuantity, 6),
    leveragedValue: r(leveragedValue),
    marginRequired: r(marginRequired),
    estimatedFees: r(leveragedValue * totalFeePercent),
    elapsedMs: Date.now() - start,
  });
}

function riskReward(args: any, start: number): string {
  const { entryPrice, stopLoss, takeProfit } = args;
  const side = args.side || "long";
  const feePercent = args.feePercent || 0.1;

  requirePositive({ entryPrice, stopLoss, takeProfit });

  const risk = Math.abs(entryPrice - stopLoss);
  const reward = Math.abs(takeProfit - entryPrice);
  if (risk === 0) throw new Error("entryPrice and stopLoss cannot be the same");

  const ratio = reward / risk;
  const riskPercent = (risk / entryPrice) * 100;
  const rewardPercent = (reward / entryPrice) * 100;
  const totalFees = (feePercent / 100) * 2 * 100; // in percent
  const netRewardPercent = rewardPercent - totalFees;
  const netRiskPercent = riskPercent + totalFees;
  const netRatio = netRewardPercent / netRiskPercent;

  // Required win rate to be profitable at this R:R
  const requiredWinRate = 1 / (1 + ratio);

  // Grade the trade
  let grade: string;
  if (ratio >= 3) grade = "A — Excellent";
  else if (ratio >= 2) grade = "B — Good";
  else if (ratio >= 1.5) grade = "C — Acceptable";
  else if (ratio >= 1) grade = "D — Marginal";
  else grade = "F — Poor (risk > reward)";

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
    netRatio: r(netRatio, 2),
    requiredWinRate: r(requiredWinRate * 100, 1),
    grade,
    elapsedMs: Date.now() - start,
  });
}

function stopLossCalc(args: any, start: number): string {
  const { entryPrice, riskPercent, accountSize, quantity } = args;
  const side = args.side || "long";

  requirePositive({ entryPrice });

  const results: any = { status: "ok", action: "stop_loss", side, entryPrice };

  // Method 1: Percentage-based
  if (riskPercent) {
    const slDistance = entryPrice * (riskPercent / 100);
    results.percentageBased = {
      riskPercent,
      stopLoss: r(side === "long" ? entryPrice - slDistance : entryPrice + slDistance),
      distance: r(slDistance),
    };
  }

  // Method 2: Fixed dollar risk
  if (accountSize && riskPercent && quantity) {
    const maxRisk = accountSize * (riskPercent / 100);
    const slDistance = maxRisk / quantity;
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
    formula: side === "long" ? "SL = entry - (ATR × multiplier)" : "SL = entry + (ATR × multiplier)",
  };

  results.elapsedMs = Date.now() - start;
  return JSON.stringify(results);
}

function takeProfitCalc(args: any, start: number): string {
  const { entryPrice, stopLoss, targets } = args;
  const side = args.side || "long";

  requirePositive({ entryPrice });

  const results: any = { status: "ok", action: "take_profit", side, entryPrice };

  // R-multiple targets
  if (stopLoss) {
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

  // Multi-target analysis
  if (targets && Array.isArray(targets)) {
    let totalPercent = 0;
    results.multiTarget = targets.map((t: any) => {
      const pct = t.percent || 0;
      totalPercent += pct;
      const distance = Math.abs(t.price - entryPrice);
      return {
        price: t.price,
        closePercent: pct,
        profitPercent: r((distance / entryPrice) * 100),
      };
    });
    if (totalPercent !== 100) {
      results.multiTargetWarning = `Target percentages sum to ${totalPercent}%, should be 100%`;
    }
  }

  results.elapsedMs = Date.now() - start;
  return JSON.stringify(results);
}

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
      ? "Negative edge — do not trade this strategy"
      : `Risk ${r(fractionalKelly * 100, 1)}% of account per trade (${kellyFraction === 0.5 ? "half" : r(kellyFraction * 100)}% Kelly)`,
  };

  if (accountSize && accountSize > 0) {
    results.riskAmount = r(accountSize * Math.max(0, fractionalKelly));
  }

  // Edge and expected value
  results.edge = r((winRate * avgWin - q * avgLoss), 2);
  results.expectedValuePerTrade = r((winRate * avgWin - q * avgLoss), 2);

  results.elapsedMs = Date.now() - start;
  return JSON.stringify(results);
}

function breakevenCalc(args: any, start: number): string {
  const { entryPrice, feePercent = 0.1, leverage = 1 } = args;
  const side = args.side || "long";

  requirePositive({ entryPrice });

  const totalFeePercent = (feePercent / 100) * 2; // entry + exit
  const breakevenDistance = entryPrice * totalFeePercent;

  const breakevenPrice = side === "long"
    ? entryPrice + breakevenDistance
    : entryPrice - breakevenDistance;

  // With leverage, the fee impact is amplified
  const leveragedBreakevenDistance = breakevenDistance / leverage;
  const leveragedBreakevenPrice = side === "long"
    ? entryPrice + leveragedBreakevenDistance
    : entryPrice - leveragedBreakevenDistance;

  return JSON.stringify({
    status: "ok",
    action: "breakeven",
    side,
    entryPrice,
    feePercent,
    totalFees: r(totalFeePercent * 100, 3),
    breakevenPrice: r(breakevenPrice),
    breakevenDistance: r(breakevenDistance),
    breakevenPercent: r(totalFeePercent * 100, 3),
    leverage,
    ...(leverage > 1 && {
      leveragedBreakevenPrice: r(leveragedBreakevenPrice),
      leveragedBreakevenPercent: r((totalFeePercent / leverage) * 100, 4),
    }),
    elapsedMs: Date.now() - start,
  });
}

function liquidationCalc(args: any, start: number): string {
  const { entryPrice, leverage, maintenanceMargin = 0.005 } = args;
  const side = args.side || "long";

  requirePositive({ entryPrice, leverage });
  if (leverage < 1) throw new Error("leverage must be >= 1");

  // Liquidation price formula:
  // Long: entryPrice * (1 - 1/leverage + maintenanceMargin)
  // Short: entryPrice * (1 + 1/leverage - maintenanceMargin)
  const liqPrice = side === "long"
    ? entryPrice * (1 - (1 / leverage) + maintenanceMargin)
    : entryPrice * (1 + (1 / leverage) - maintenanceMargin);

  const distancePercent = Math.abs(entryPrice - liqPrice) / entryPrice * 100;

  return JSON.stringify({
    status: "ok",
    action: "liquidation",
    side,
    entryPrice,
    leverage,
    maintenanceMargin: r(maintenanceMargin * 100, 2),
    liquidationPrice: r(liqPrice),
    distanceToLiquidation: r(distancePercent, 2),
    warning: distancePercent < 5 ? "⚠ Liquidation is very close to entry — high risk" : undefined,
    elapsedMs: Date.now() - start,
  });
}

function compoundCalc(args: any, start: number): string {
  const { startingCapital, returnPercent, trades, reinvestPercent = 100 } = args;

  requirePositive({ startingCapital, returnPercent, trades });
  if (trades > 1000) throw new Error("trades max is 1000");

  const reinvestFraction = Math.min(100, Math.max(0, reinvestPercent)) / 100;
  let capital = startingCapital;
  const milestones: Array<{ trade: number; capital: number; totalReturn: number }> = [];

  for (let i = 1; i <= trades; i++) {
    const profit = capital * (returnPercent / 100);
    const reinvested = profit * reinvestFraction;
    capital += reinvested;

    // Record milestones
    if (i <= 5 || i % 10 === 0 || i === trades) {
      milestones.push({
        trade: i,
        capital: r(capital, 2),
        totalReturn: r(((capital - startingCapital) / startingCapital) * 100, 2),
      });
    }
  }

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
    milestones,
    elapsedMs: Date.now() - start,
  });
}

/* ────────────────────── helpers ────────────────────── */

function r(n: number, decimals = 4): number {
  return Math.round(n * Math.pow(10, decimals)) / Math.pow(10, decimals);
}

function requirePositive(fields: Record<string, any>): void {
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined || value === null) throw new Error(`${name} is required`);
    if (typeof value !== "number" || value <= 0) throw new Error(`${name} must be a positive number`);
  }
}
