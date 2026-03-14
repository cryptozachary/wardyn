import { promises as fs } from "fs";
import path from "path";
import crypto from "crypto";

export const parameters = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["open", "close", "update", "list", "history", "summary", "delete", "note"],
      description:
        "Action: open (new position), close (exit position), update (modify SL/TP), list (active positions), history (closed trades), summary (P&L overview), delete (remove position), note (add note to position).",
    },
    // Position fields
    symbol: { type: "string", description: "Trading pair (e.g. BTC/USDT)" },
    side: { type: "string", enum: ["long", "short"], description: "Trade direction" },
    entryPrice: { type: "number", description: "Entry price" },
    quantity: { type: "number", description: "Position size in base asset units" },
    stopLoss: { type: "number", description: "Stop loss price" },
    takeProfit: { type: "number", description: "Take profit price" },
    exchange: { type: "string", description: "Exchange name (for tracking)" },
    strategy: { type: "string", description: "Strategy name that triggered this trade" },
    tags: {
      type: "array",
      items: { type: "string" },
      description: "Tags for categorization (e.g. ['swing', 'breakout'])",
    },

    // Close fields
    exitPrice: { type: "number", description: "Exit price (required for close)" },
    id: { type: "string", description: "Position ID (required for close/update/delete/note)" },

    // Fee fields
    feePercent: { type: "number", description: "Total round-trip fee percentage (default: 0.2 = 0.1% entry + 0.1% exit)" },
    slippagePercent: { type: "number", description: "Estimated slippage percentage (default: 0)" },

    // Note
    note: { type: "string", description: "Note text to add to a position" },

    // Filters & pagination
    status: { type: "string", enum: ["open", "closed", "all"], description: "Filter by status (default: open for list, closed for history)" },
    portfolioName: { type: "string", description: "Portfolio name (default: 'default'). Mutating actions scope to this portfolio." },
    limit: { type: "number", description: "Max results (default: 50 for history, 50 for list)" },
    offset: { type: "number", description: "Skip first N results for pagination (default: 0)" },
    sortBy: { type: "string", enum: ["openedAt", "entryPrice", "symbol", "pnl", "closedAt"], description: "Sort field (default: openedAt for list, closedAt for history)" },
    sortOrder: { type: "string", enum: ["asc", "desc"], description: "Sort direction (default: desc)" },
  },
  required: ["action"],
};

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

interface Position {
  id: string;
  symbol: string;
  side: "long" | "short";
  entryPrice: number;
  quantity: number;
  stopLoss?: number;
  takeProfit?: number;
  exchange?: string;
  strategy?: string;
  tags: string[];
  notes: Array<{ text: string; ts: string }>;
  status: "open" | "closed";
  openedAt: string;
  closedAt?: string;
  exitPrice?: number;
  pnl?: number;
  pnlPercent?: number;
  pnlNet?: number;
  pnlNetPercent?: number;
  feePercent?: number;
  slippagePercent?: number;
  totalFees?: number;
  portfolioName: string;
}

interface PortfolioStore {
  positions: Position[];
}

/* ------------------------------------------------------------------ */
/*  Constants                                                         */
/* ------------------------------------------------------------------ */

const CONFIG_DIR = path.join(process.cwd(), "config");
const STORE_PATH = path.join(CONFIG_DIR, "portfolio.json");
const BACKUP_PATH = path.join(CONFIG_DIR, "portfolio.backup.json");
const MAX_POSITIONS_PER_PORTFOLIO = 500;
const MAX_NOTES_PER_POSITION = 50;
const DEFAULT_FEE_PERCENT = 0.2; // 0.1% entry + 0.1% exit

/* ------------------------------------------------------------------ */
/*  Concurrency-safe persistence                                      */
/* ------------------------------------------------------------------ */

let storeLock: Promise<void> = Promise.resolve();

function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = storeLock;
  let resolve: () => void;
  storeLock = new Promise<void>((r) => (resolve = r));
  return prev.then(fn).finally(() => resolve!());
}

async function loadStore(): Promise<PortfolioStore> {
  try {
    const raw = await fs.readFile(STORE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    // Basic structure validation
    if (!parsed || !Array.isArray(parsed.positions)) {
      throw new Error("Invalid store structure");
    }
    return parsed;
  } catch (err: any) {
    // File not found -- fresh store
    if (err.code === "ENOENT") return { positions: [] };
    // JSON parse error or invalid structure -- corruption
    if (err instanceof SyntaxError || err.message === "Invalid store structure") {
      // Try to read backup
      try {
        const backupRaw = await fs.readFile(BACKUP_PATH, "utf8");
        const backup = JSON.parse(backupRaw);
        if (backup && Array.isArray(backup.positions)) {
          // Restore from backup, save as primary
          await fs.writeFile(STORE_PATH, backupRaw, "utf8");
          return backup;
        }
      } catch { /* backup also failed */ }
      // No backup available -- throw rather than silently reset
      throw new Error(
        `portfolio.json is corrupted and no valid backup exists. ` +
        `Manual fix: inspect config/portfolio.json or delete it to start fresh.`
      );
    }
    throw err;
  }
}

async function saveStore(store: PortfolioStore): Promise<void> {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  const data = JSON.stringify(store, null, 2);
  const tmp = path.join(CONFIG_DIR, `.portfolio_tmp_${crypto.randomBytes(8).toString("hex")}`);
  try {
    // Backup current file before overwriting
    try {
      await fs.copyFile(STORE_PATH, BACKUP_PATH);
    } catch { /* no existing file to backup */ }
    await fs.writeFile(tmp, data, "utf8");
    await fs.rename(tmp, STORE_PATH);
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
}

/* ------------------------------------------------------------------ */
/*  ID generation with collision check                                */
/* ------------------------------------------------------------------ */

function generateId(existing: Set<string>): string {
  // 12 hex chars = 6 bytes = 281 trillion possible IDs
  for (let i = 0; i < 10; i++) {
    const id = crypto.randomBytes(6).toString("hex");
    if (!existing.has(id)) return id;
  }
  // Fallback: 16 bytes (practically impossible to collide)
  return crypto.randomBytes(16).toString("hex");
}

/* ------------------------------------------------------------------ */
/*  P&L calculation (with fees + slippage)                            */
/* ------------------------------------------------------------------ */

function calcPnl(
  side: "long" | "short",
  entryPrice: number,
  exitPrice: number,
  quantity: number,
  feePercent: number,
  slippagePercent: number,
): { pnl: number; pnlPercent: number; pnlNet: number; pnlNetPercent: number; totalFees: number } {
  // Gross P&L
  const pnl = side === "long"
    ? (exitPrice - entryPrice) * quantity
    : (entryPrice - exitPrice) * quantity;
  const pnlPercent = side === "long"
    ? ((exitPrice - entryPrice) / entryPrice) * 100
    : ((entryPrice - exitPrice) / entryPrice) * 100;

  // Fee + slippage cost
  const notional = entryPrice * quantity;
  const totalFeeRate = (feePercent + slippagePercent) / 100;
  const totalFees = notional * totalFeeRate;

  // Net P&L
  const pnlNet = pnl - totalFees;
  const pnlNetPercent = (pnlNet / notional) * 100;

  return {
    pnl: round(pnl),
    pnlPercent: round(pnlPercent),
    pnlNet: round(pnlNet),
    pnlNetPercent: round(pnlNetPercent),
    totalFees: round(totalFees),
  };
}

function round(n: number, decimals = 4): number {
  return Math.round(n * Math.pow(10, decimals)) / Math.pow(10, decimals);
}

/* ------------------------------------------------------------------ */
/*  Portfolio-scoped position lookup                                  */
/* ------------------------------------------------------------------ */

function findPosition(store: PortfolioStore, id: string, portfolioName: string): Position {
  const pos = store.positions.find((p) => p.id === id && p.portfolioName === portfolioName);
  if (!pos) {
    // Check if it exists in another portfolio for a better error message
    const other = store.positions.find((p) => p.id === id);
    if (other) {
      throw new Error(`Position ${id} belongs to portfolio "${other.portfolioName}", not "${portfolioName}"`);
    }
    throw new Error(`Position ${id} not found in portfolio "${portfolioName}"`);
  }
  return pos;
}

/* ------------------------------------------------------------------ */
/*  Execute                                                           */
/* ------------------------------------------------------------------ */

export async function execute(args: any): Promise<string> {
  const start = Date.now();
  const { action } = args;

  try {
    switch (action) {
      case "open": return await withLock(() => handleOpen(args, start));
      case "close": return await withLock(() => handleClose(args, start));
      case "update": return await withLock(() => handleUpdate(args, start));
      case "list": return await handleList(args, start);
      case "history": return await handleHistory(args, start);
      case "summary": return await handleSummary(args, start);
      case "delete": return await withLock(() => handleDelete(args, start));
      case "note": return await withLock(() => handleNote(args, start));
      default:
        throw new Error(`Unknown action: ${action}. Use: open, close, update, list, history, summary, delete, note`);
    }
  } catch (err: any) {
    return JSON.stringify({ status: "error", action, error: err.message, elapsedMs: Date.now() - start });
  }
}

/* ------------------------------------------------------------------ */
/*  open                                                              */
/* ------------------------------------------------------------------ */

async function handleOpen(args: any, start: number): Promise<string> {
  const { symbol, side, entryPrice, quantity, stopLoss, takeProfit, exchange, strategy, tags } = args;
  const portfolioName = args.portfolioName || "default";

  if (!symbol || typeof symbol !== "string") throw new Error("symbol is required");
  if (!side || !["long", "short"].includes(side)) throw new Error("side must be 'long' or 'short'");
  if (!entryPrice || typeof entryPrice !== "number" || entryPrice <= 0) throw new Error("entryPrice must be a positive number");
  if (!quantity || typeof quantity !== "number" || quantity <= 0) throw new Error("quantity must be a positive number");

  // Validate SL/TP logic
  if (stopLoss !== undefined) {
    if (typeof stopLoss !== "number" || stopLoss <= 0) throw new Error("stopLoss must be a positive number");
    if (side === "long" && stopLoss >= entryPrice) throw new Error("stopLoss must be below entryPrice for long positions");
    if (side === "short" && stopLoss <= entryPrice) throw new Error("stopLoss must be above entryPrice for short positions");
  }
  if (takeProfit !== undefined) {
    if (typeof takeProfit !== "number" || takeProfit <= 0) throw new Error("takeProfit must be a positive number");
    if (side === "long" && takeProfit <= entryPrice) throw new Error("takeProfit must be above entryPrice for long positions");
    if (side === "short" && takeProfit >= entryPrice) throw new Error("takeProfit must be below entryPrice for short positions");
  }

  const store = await loadStore();

  // Per-portfolio open position limit
  const openInPortfolio = store.positions.filter(
    (p) => p.status === "open" && p.portfolioName === portfolioName,
  ).length;
  if (openInPortfolio >= MAX_POSITIONS_PER_PORTFOLIO) {
    throw new Error(`Max open positions (${MAX_POSITIONS_PER_PORTFOLIO}) reached in portfolio "${portfolioName}"`);
  }

  const existingIds = new Set(store.positions.map((p) => p.id));

  const position: Position = {
    id: generateId(existingIds),
    symbol: symbol.toUpperCase().trim(),
    side,
    entryPrice,
    quantity,
    ...(stopLoss !== undefined && { stopLoss }),
    ...(takeProfit !== undefined && { takeProfit }),
    ...(exchange && { exchange }),
    ...(strategy && { strategy }),
    tags: Array.isArray(tags) ? tags : [],
    notes: [],
    status: "open",
    openedAt: new Date().toISOString(),
    portfolioName,
  };

  store.positions.push(position);
  await saveStore(store);

  const riskReward = stopLoss && takeProfit
    ? round(Math.abs(takeProfit - entryPrice) / Math.abs(entryPrice - stopLoss), 2)
    : undefined;

  return JSON.stringify({
    status: "ok",
    action: "open",
    position: {
      id: position.id,
      symbol: position.symbol,
      side: position.side,
      entryPrice,
      quantity,
      stopLoss,
      takeProfit,
      riskReward,
      notionalValue: round(entryPrice * quantity, 2),
      maxLoss: stopLoss ? round(Math.abs(entryPrice - stopLoss) * quantity, 2) : undefined,
      maxProfit: takeProfit ? round(Math.abs(takeProfit - entryPrice) * quantity, 2) : undefined,
      portfolioName,
    },
    elapsedMs: Date.now() - start,
  });
}

/* ------------------------------------------------------------------ */
/*  close                                                             */
/* ------------------------------------------------------------------ */

async function handleClose(args: any, start: number): Promise<string> {
  const { id, exitPrice } = args;
  const portfolioName = args.portfolioName || "default";
  if (!id) throw new Error("id is required for close");
  if (!exitPrice || typeof exitPrice !== "number" || exitPrice <= 0) throw new Error("exitPrice must be a positive number");

  const feePercent = typeof args.feePercent === "number" ? Math.max(0, args.feePercent) : DEFAULT_FEE_PERCENT;
  const slippagePercent = typeof args.slippagePercent === "number" ? Math.max(0, args.slippagePercent) : 0;

  const store = await loadStore();
  const pos = findPosition(store, id, portfolioName);
  if (pos.status === "closed") throw new Error(`Position ${id} is already closed`);

  const { pnl, pnlPercent, pnlNet, pnlNetPercent, totalFees } = calcPnl(
    pos.side, pos.entryPrice, exitPrice, pos.quantity, feePercent, slippagePercent,
  );

  pos.status = "closed";
  pos.exitPrice = exitPrice;
  pos.closedAt = new Date().toISOString();
  pos.pnl = pnl;
  pos.pnlPercent = pnlPercent;
  pos.pnlNet = pnlNet;
  pos.pnlNetPercent = pnlNetPercent;
  pos.feePercent = feePercent;
  pos.slippagePercent = slippagePercent;
  pos.totalFees = totalFees;

  await saveStore(store);

  return JSON.stringify({
    status: "ok",
    action: "close",
    position: {
      id: pos.id,
      symbol: pos.symbol,
      side: pos.side,
      entryPrice: pos.entryPrice,
      exitPrice,
      quantity: pos.quantity,
      pnlGross: pnl,
      pnlGrossPercent: pnlPercent,
      pnlNet,
      pnlNetPercent,
      totalFees,
      feePercent,
      slippagePercent,
      result: pnlNet >= 0 ? "win" : "loss",
      holdingPeriod: pos.closedAt && pos.openedAt
        ? formatDuration(new Date(pos.closedAt).getTime() - new Date(pos.openedAt).getTime())
        : undefined,
    },
    elapsedMs: Date.now() - start,
  });
}

/* ------------------------------------------------------------------ */
/*  update                                                            */
/* ------------------------------------------------------------------ */

async function handleUpdate(args: any, start: number): Promise<string> {
  const { id, stopLoss, takeProfit } = args;
  const portfolioName = args.portfolioName || "default";
  if (!id) throw new Error("id is required for update");

  const store = await loadStore();
  const pos = findPosition(store, id, portfolioName);
  if (pos.status === "closed") throw new Error(`Cannot update closed position ${id}`);

  if (stopLoss !== undefined) {
    if (typeof stopLoss !== "number" || stopLoss <= 0) throw new Error("stopLoss must be a positive number");
    if (pos.side === "long" && stopLoss >= pos.entryPrice) throw new Error("stopLoss must be below entryPrice for long");
    if (pos.side === "short" && stopLoss <= pos.entryPrice) throw new Error("stopLoss must be above entryPrice for short");
    pos.stopLoss = stopLoss;
  }
  if (takeProfit !== undefined) {
    if (typeof takeProfit !== "number" || takeProfit <= 0) throw new Error("takeProfit must be a positive number");
    if (pos.side === "long" && takeProfit <= pos.entryPrice) throw new Error("takeProfit must be above entryPrice for long");
    if (pos.side === "short" && takeProfit >= pos.entryPrice) throw new Error("takeProfit must be below entryPrice for short");
    pos.takeProfit = takeProfit;
  }

  await saveStore(store);

  return JSON.stringify({
    status: "ok",
    action: "update",
    id,
    symbol: pos.symbol,
    stopLoss: pos.stopLoss,
    takeProfit: pos.takeProfit,
    portfolioName,
    elapsedMs: Date.now() - start,
  });
}

/* ------------------------------------------------------------------ */
/*  list (with status filter, pagination, sorting)                    */
/* ------------------------------------------------------------------ */

async function handleList(args: any, start: number): Promise<string> {
  const store = await loadStore();
  const portfolioName = args.portfolioName || "default";
  const statusFilter: string = args.status || "open";
  const limit = Math.min(Math.max(1, Number(args.limit) || 50), 200);
  const offset = Math.max(0, Number(args.offset) || 0);
  const sortBy = args.sortBy || "openedAt";
  const sortOrder = args.sortOrder || "desc";

  let positions = store.positions.filter((p) => p.portfolioName === portfolioName);

  // Status filter
  if (statusFilter !== "all") {
    positions = positions.filter((p) => p.status === statusFilter);
  }

  // Sort
  positions.sort((a, b) => {
    let av: any, bv: any;
    switch (sortBy) {
      case "entryPrice": av = a.entryPrice; bv = b.entryPrice; break;
      case "symbol": av = a.symbol; bv = b.symbol; break;
      case "pnl": av = a.pnl ?? 0; bv = b.pnl ?? 0; break;
      case "closedAt": av = a.closedAt || ""; bv = b.closedAt || ""; break;
      default: av = a.openedAt; bv = b.openedAt; break;
    }
    if (av < bv) return sortOrder === "asc" ? -1 : 1;
    if (av > bv) return sortOrder === "asc" ? 1 : -1;
    return 0;
  });

  const total = positions.length;
  positions = positions.slice(offset, offset + limit);

  return JSON.stringify({
    status: "ok",
    action: "list",
    portfolioName,
    statusFilter,
    total,
    offset,
    count: positions.length,
    positions: positions.map((p) => ({
      id: p.id,
      symbol: p.symbol,
      side: p.side,
      status: p.status,
      entryPrice: p.entryPrice,
      exitPrice: p.exitPrice,
      quantity: p.quantity,
      stopLoss: p.stopLoss,
      takeProfit: p.takeProfit,
      exchange: p.exchange,
      strategy: p.strategy,
      tags: p.tags,
      pnl: p.pnl,
      pnlNet: p.pnlNet,
      notionalValue: round(p.entryPrice * p.quantity, 2),
      openedAt: p.openedAt,
      closedAt: p.closedAt,
      noteCount: p.notes.length,
    })),
    elapsedMs: Date.now() - start,
  });
}

/* ------------------------------------------------------------------ */
/*  history                                                           */
/* ------------------------------------------------------------------ */

async function handleHistory(args: any, start: number): Promise<string> {
  const store = await loadStore();
  const portfolioName = args.portfolioName || "default";
  const limit = Math.min(Math.max(1, Number(args.limit) || 50), 200);
  const offset = Math.max(0, Number(args.offset) || 0);
  const statusFilter: string = args.status || "closed";

  let positions = store.positions.filter((p) => p.portfolioName === portfolioName);

  // Status filter
  if (statusFilter !== "all") {
    positions = positions.filter((p) => p.status === statusFilter);
  }

  // Sort by closedAt descending (most recent first)
  positions.sort((a, b) => {
    const at = a.closedAt || a.openedAt;
    const bt = b.closedAt || b.openedAt;
    return new Date(bt).getTime() - new Date(at).getTime();
  });

  const total = positions.length;
  positions = positions.slice(offset, offset + limit);

  return JSON.stringify({
    status: "ok",
    action: "history",
    portfolioName,
    statusFilter,
    total,
    offset,
    count: positions.length,
    trades: positions.map((p) => ({
      id: p.id,
      symbol: p.symbol,
      side: p.side,
      entryPrice: p.entryPrice,
      exitPrice: p.exitPrice,
      quantity: p.quantity,
      pnlGross: p.pnl,
      pnlNet: p.pnlNet,
      pnlNetPercent: p.pnlNetPercent,
      totalFees: p.totalFees,
      result: (p.pnlNet ?? p.pnl ?? 0) >= 0 ? "win" : "loss",
      strategy: p.strategy,
      openedAt: p.openedAt,
      closedAt: p.closedAt,
    })),
    elapsedMs: Date.now() - start,
  });
}

/* ------------------------------------------------------------------ */
/*  summary                                                           */
/* ------------------------------------------------------------------ */

async function handleSummary(args: any, start: number): Promise<string> {
  const store = await loadStore();
  const portfolioName = args.portfolioName || "default";

  const open = store.positions.filter((p) => p.status === "open" && p.portfolioName === portfolioName);
  const closed = store.positions.filter((p) => p.status === "closed" && p.portfolioName === portfolioName);

  // Use net P&L when available, fall back to gross
  const getPnl = (p: Position) => p.pnlNet ?? p.pnl ?? 0;

  const wins = closed.filter((p) => getPnl(p) >= 0);
  const losses = closed.filter((p) => getPnl(p) < 0);
  const totalPnlGross = closed.reduce((sum, p) => sum + (p.pnl ?? 0), 0);
  const totalPnlNet = closed.reduce((sum, p) => sum + getPnl(p), 0);
  const totalFees = closed.reduce((sum, p) => sum + (p.totalFees ?? 0), 0);
  const totalWinPnl = wins.reduce((sum, p) => sum + getPnl(p), 0);
  const totalLossPnl = losses.reduce((sum, p) => sum + getPnl(p), 0);
  const avgWin = wins.length > 0 ? totalWinPnl / wins.length : 0;
  const avgLoss = losses.length > 0 ? Math.abs(totalLossPnl) / losses.length : 0;
  const winRate = closed.length > 0 ? (wins.length / closed.length) * 100 : 0;
  const profitFactor = totalLossPnl !== 0 ? Math.abs(totalWinPnl / totalLossPnl) : totalWinPnl > 0 ? Infinity : 0;
  const expectancy = closed.length > 0 ? totalPnlNet / closed.length : 0;

  // Largest win/loss
  const largestWin = wins.length > 0 ? wins.reduce((best, p) => getPnl(p) > getPnl(best) ? p : best) : null;
  const largestLoss = losses.length > 0 ? losses.reduce((worst, p) => getPnl(p) < getPnl(worst) ? p : worst) : null;

  // Win/loss streaks
  let currentStreak = 0;
  let maxWinStreak = 0;
  let maxLossStreak = 0;
  const sortedClosed = [...closed].sort((a, b) => new Date(a.closedAt!).getTime() - new Date(b.closedAt!).getTime());
  for (const p of sortedClosed) {
    if (getPnl(p) >= 0) {
      currentStreak = currentStreak >= 0 ? currentStreak + 1 : 1;
      maxWinStreak = Math.max(maxWinStreak, currentStreak);
    } else {
      currentStreak = currentStreak <= 0 ? currentStreak - 1 : -1;
      maxLossStreak = Math.max(maxLossStreak, Math.abs(currentStreak));
    }
  }

  // Open exposure
  const totalExposure = open.reduce((sum, p) => sum + p.entryPrice * p.quantity, 0);

  // By strategy breakdown
  const strategyMap: Record<string, { wins: number; losses: number; pnlNet: number; fees: number }> = {};
  for (const p of closed) {
    const s = p.strategy || "untagged";
    if (!strategyMap[s]) strategyMap[s] = { wins: 0, losses: 0, pnlNet: 0, fees: 0 };
    strategyMap[s].pnlNet += getPnl(p);
    strategyMap[s].fees += p.totalFees ?? 0;
    if (getPnl(p) >= 0) strategyMap[s].wins++;
    else strategyMap[s].losses++;
  }

  return JSON.stringify({
    status: "ok",
    action: "summary",
    portfolioName,
    openPositions: open.length,
    maxOpenPositions: MAX_POSITIONS_PER_PORTFOLIO,
    totalExposure: round(totalExposure, 2),
    closedTrades: closed.length,
    wins: wins.length,
    losses: losses.length,
    winRate: round(winRate, 1),
    totalPnlGross: round(totalPnlGross, 2),
    totalPnlNet: round(totalPnlNet, 2),
    totalFees: round(totalFees, 2),
    avgWin: round(avgWin, 2),
    avgLoss: round(avgLoss, 2),
    profitFactor: profitFactor === Infinity ? "Infinity" : round(profitFactor, 2),
    expectancy: round(expectancy, 2),
    maxWinStreak,
    maxLossStreak,
    largestWin: largestWin ? { symbol: largestWin.symbol, pnl: getPnl(largestWin), strategy: largestWin.strategy } : null,
    largestLoss: largestLoss ? { symbol: largestLoss.symbol, pnl: getPnl(largestLoss), strategy: largestLoss.strategy } : null,
    byStrategy: Object.entries(strategyMap).map(([name, stats]) => ({
      strategy: name,
      trades: stats.wins + stats.losses,
      wins: stats.wins,
      losses: stats.losses,
      winRate: round(((stats.wins / (stats.wins + stats.losses)) * 100), 1),
      pnlNet: round(stats.pnlNet, 2),
      fees: round(stats.fees, 2),
    })),
    elapsedMs: Date.now() - start,
  });
}

/* ------------------------------------------------------------------ */
/*  delete (portfolio-scoped)                                         */
/* ------------------------------------------------------------------ */

async function handleDelete(args: any, start: number): Promise<string> {
  const { id } = args;
  const portfolioName = args.portfolioName || "default";
  if (!id) throw new Error("id is required for delete");

  const store = await loadStore();
  const pos = findPosition(store, id, portfolioName);
  const idx = store.positions.indexOf(pos);
  store.positions.splice(idx, 1);
  await saveStore(store);

  return JSON.stringify({ status: "ok", action: "delete", id, symbol: pos.symbol, portfolioName, elapsedMs: Date.now() - start });
}

/* ------------------------------------------------------------------ */
/*  note (portfolio-scoped)                                           */
/* ------------------------------------------------------------------ */

async function handleNote(args: any, start: number): Promise<string> {
  const { id, note } = args;
  const portfolioName = args.portfolioName || "default";
  if (!id) throw new Error("id is required for note");
  if (!note || typeof note !== "string") throw new Error("note text is required");

  const store = await loadStore();
  const pos = findPosition(store, id, portfolioName);
  if (pos.notes.length >= MAX_NOTES_PER_POSITION) throw new Error(`Max notes (${MAX_NOTES_PER_POSITION}) reached for this position`);

  pos.notes.push({ text: note.slice(0, 500), ts: new Date().toISOString() });
  await saveStore(store);

  return JSON.stringify({ status: "ok", action: "note", id, symbol: pos.symbol, portfolioName, noteCount: pos.notes.length, elapsedMs: Date.now() - start });
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function formatDuration(ms: number): string {
  if (ms <= 0) return "0s";
  const parts: string[] = [];
  const d = Math.floor(ms / 86400000); if (d) parts.push(`${d}d`);
  const h = Math.floor((ms % 86400000) / 3600000); if (h) parts.push(`${h}h`);
  const m = Math.floor((ms % 3600000) / 60000); if (m) parts.push(`${m}m`);
  if (parts.length === 0) parts.push(`${Math.floor(ms / 1000)}s`);
  return parts.join(" ");
}
