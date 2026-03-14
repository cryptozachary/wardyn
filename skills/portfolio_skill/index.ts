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

    // Note
    note: { type: "string", description: "Note text to add to a position" },

    // Filters
    status: { type: "string", enum: ["open", "closed", "all"], description: "Filter by status for list/history (default: open for list, closed for history)" },
    portfolioName: { type: "string", description: "Portfolio name (default: 'default')" },
    limit: { type: "number", description: "Max results for history (default: 50)" },
  },
  required: ["action"],
};

/* ────────────────────── types ────────────────────── */

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
  portfolioName: string;
}

interface PortfolioStore {
  positions: Position[];
}

/* ────────────────────── constants ────────────────────── */

const CONFIG_DIR = path.join(process.cwd(), "config");
const STORE_PATH = path.join(CONFIG_DIR, "portfolio.json");
const MAX_POSITIONS = 500;
const MAX_NOTES_PER_POSITION = 50;

/* ────────────────────── concurrency-safe persistence ────────────────────── */

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
    return JSON.parse(raw);
  } catch {
    return { positions: [] };
  }
}

async function saveStore(store: PortfolioStore): Promise<void> {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  const tmp = path.join(CONFIG_DIR, `.portfolio_tmp_${crypto.randomBytes(8).toString("hex")}`);
  try {
    await fs.writeFile(tmp, JSON.stringify(store, null, 2), "utf8");
    await fs.rename(tmp, STORE_PATH);
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
}

/* ────────────────────── P&L calculation ────────────────────── */

function calcPnl(side: "long" | "short", entryPrice: number, exitPrice: number, quantity: number): { pnl: number; pnlPercent: number } {
  const pnl = side === "long"
    ? (exitPrice - entryPrice) * quantity
    : (entryPrice - exitPrice) * quantity;
  const pnlPercent = side === "long"
    ? ((exitPrice - entryPrice) / entryPrice) * 100
    : ((entryPrice - exitPrice) / entryPrice) * 100;
  return { pnl: round(pnl), pnlPercent: round(pnlPercent) };
}

function round(n: number, decimals = 4): number {
  return Math.round(n * Math.pow(10, decimals)) / Math.pow(10, decimals);
}

/* ────────────────────── execute ────────────────────── */

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
  const openCount = store.positions.filter((p) => p.status === "open").length;
  if (openCount >= MAX_POSITIONS) throw new Error(`Max open positions (${MAX_POSITIONS}) reached`);

  const position: Position = {
    id: crypto.randomBytes(4).toString("hex"),
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
    },
    elapsedMs: Date.now() - start,
  });
}

async function handleClose(args: any, start: number): Promise<string> {
  const { id, exitPrice } = args;
  if (!id) throw new Error("id is required for close");
  if (!exitPrice || typeof exitPrice !== "number" || exitPrice <= 0) throw new Error("exitPrice must be a positive number");

  const store = await loadStore();
  const pos = store.positions.find((p) => p.id === id);
  if (!pos) throw new Error(`Position ${id} not found`);
  if (pos.status === "closed") throw new Error(`Position ${id} is already closed`);

  const { pnl, pnlPercent } = calcPnl(pos.side, pos.entryPrice, exitPrice, pos.quantity);

  pos.status = "closed";
  pos.exitPrice = exitPrice;
  pos.closedAt = new Date().toISOString();
  pos.pnl = pnl;
  pos.pnlPercent = pnlPercent;

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
      pnl,
      pnlPercent,
      result: pnl >= 0 ? "win" : "loss",
      holdingPeriod: pos.closedAt && pos.openedAt
        ? formatDuration(new Date(pos.closedAt).getTime() - new Date(pos.openedAt).getTime())
        : undefined,
    },
    elapsedMs: Date.now() - start,
  });
}

async function handleUpdate(args: any, start: number): Promise<string> {
  const { id, stopLoss, takeProfit } = args;
  if (!id) throw new Error("id is required for update");

  const store = await loadStore();
  const pos = store.positions.find((p) => p.id === id);
  if (!pos) throw new Error(`Position ${id} not found`);
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
    elapsedMs: Date.now() - start,
  });
}

async function handleList(args: any, start: number): Promise<string> {
  const store = await loadStore();
  const portfolioName = args.portfolioName || "default";
  const positions = store.positions.filter(
    (p) => p.status === "open" && p.portfolioName === portfolioName,
  );

  return JSON.stringify({
    status: "ok",
    action: "list",
    portfolioName,
    count: positions.length,
    positions: positions.map((p) => ({
      id: p.id,
      symbol: p.symbol,
      side: p.side,
      entryPrice: p.entryPrice,
      quantity: p.quantity,
      stopLoss: p.stopLoss,
      takeProfit: p.takeProfit,
      exchange: p.exchange,
      strategy: p.strategy,
      tags: p.tags,
      notionalValue: round(p.entryPrice * p.quantity, 2),
      openedAt: p.openedAt,
      noteCount: p.notes.length,
    })),
    elapsedMs: Date.now() - start,
  });
}

async function handleHistory(args: any, start: number): Promise<string> {
  const store = await loadStore();
  const portfolioName = args.portfolioName || "default";
  const limit = Math.min(Math.max(1, Number(args.limit) || 50), 200);

  let positions = store.positions.filter(
    (p) => p.status === "closed" && p.portfolioName === portfolioName,
  );

  // Sort by closedAt descending (most recent first)
  positions.sort((a, b) => new Date(b.closedAt!).getTime() - new Date(a.closedAt!).getTime());
  positions = positions.slice(0, limit);

  return JSON.stringify({
    status: "ok",
    action: "history",
    portfolioName,
    count: positions.length,
    trades: positions.map((p) => ({
      id: p.id,
      symbol: p.symbol,
      side: p.side,
      entryPrice: p.entryPrice,
      exitPrice: p.exitPrice,
      quantity: p.quantity,
      pnl: p.pnl,
      pnlPercent: p.pnlPercent,
      result: (p.pnl ?? 0) >= 0 ? "win" : "loss",
      strategy: p.strategy,
      openedAt: p.openedAt,
      closedAt: p.closedAt,
    })),
    elapsedMs: Date.now() - start,
  });
}

async function handleSummary(args: any, start: number): Promise<string> {
  const store = await loadStore();
  const portfolioName = args.portfolioName || "default";

  const open = store.positions.filter((p) => p.status === "open" && p.portfolioName === portfolioName);
  const closed = store.positions.filter((p) => p.status === "closed" && p.portfolioName === portfolioName);

  const wins = closed.filter((p) => (p.pnl ?? 0) >= 0);
  const losses = closed.filter((p) => (p.pnl ?? 0) < 0);
  const totalPnl = closed.reduce((sum, p) => sum + (p.pnl ?? 0), 0);
  const totalWinPnl = wins.reduce((sum, p) => sum + (p.pnl ?? 0), 0);
  const totalLossPnl = losses.reduce((sum, p) => sum + (p.pnl ?? 0), 0);
  const avgWin = wins.length > 0 ? totalWinPnl / wins.length : 0;
  const avgLoss = losses.length > 0 ? Math.abs(totalLossPnl) / losses.length : 0;
  const winRate = closed.length > 0 ? (wins.length / closed.length) * 100 : 0;
  const profitFactor = totalLossPnl !== 0 ? Math.abs(totalWinPnl / totalLossPnl) : totalWinPnl > 0 ? Infinity : 0;
  const expectancy = closed.length > 0 ? totalPnl / closed.length : 0;

  // Largest win/loss
  const largestWin = wins.length > 0 ? wins.reduce((best, p) => (p.pnl ?? 0) > (best.pnl ?? 0) ? p : best) : null;
  const largestLoss = losses.length > 0 ? losses.reduce((worst, p) => (p.pnl ?? 0) < (worst.pnl ?? 0) ? p : worst) : null;

  // Win/loss streaks
  let currentStreak = 0;
  let maxWinStreak = 0;
  let maxLossStreak = 0;
  for (const p of closed.sort((a, b) => new Date(a.closedAt!).getTime() - new Date(b.closedAt!).getTime())) {
    if ((p.pnl ?? 0) >= 0) {
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
  const strategyMap: Record<string, { wins: number; losses: number; pnl: number }> = {};
  for (const p of closed) {
    const s = p.strategy || "untagged";
    if (!strategyMap[s]) strategyMap[s] = { wins: 0, losses: 0, pnl: 0 };
    strategyMap[s].pnl += p.pnl ?? 0;
    if ((p.pnl ?? 0) >= 0) strategyMap[s].wins++;
    else strategyMap[s].losses++;
  }

  return JSON.stringify({
    status: "ok",
    action: "summary",
    portfolioName,
    openPositions: open.length,
    totalExposure: round(totalExposure, 2),
    closedTrades: closed.length,
    wins: wins.length,
    losses: losses.length,
    winRate: round(winRate, 1),
    totalPnl: round(totalPnl, 2),
    avgWin: round(avgWin, 2),
    avgLoss: round(avgLoss, 2),
    profitFactor: profitFactor === Infinity ? "∞" : round(profitFactor, 2),
    expectancy: round(expectancy, 2),
    maxWinStreak,
    maxLossStreak,
    largestWin: largestWin ? { symbol: largestWin.symbol, pnl: largestWin.pnl, strategy: largestWin.strategy } : null,
    largestLoss: largestLoss ? { symbol: largestLoss.symbol, pnl: largestLoss.pnl, strategy: largestLoss.strategy } : null,
    byStrategy: Object.entries(strategyMap).map(([name, stats]) => ({
      strategy: name,
      trades: stats.wins + stats.losses,
      wins: stats.wins,
      losses: stats.losses,
      winRate: round(((stats.wins / (stats.wins + stats.losses)) * 100), 1),
      pnl: round(stats.pnl, 2),
    })),
    elapsedMs: Date.now() - start,
  });
}

async function handleDelete(args: any, start: number): Promise<string> {
  const { id } = args;
  if (!id) throw new Error("id is required for delete");
  const store = await loadStore();
  const idx = store.positions.findIndex((p) => p.id === id);
  if (idx < 0) throw new Error(`Position ${id} not found`);
  const removed = store.positions.splice(idx, 1)[0];
  await saveStore(store);
  return JSON.stringify({ status: "ok", action: "delete", id, symbol: removed.symbol, elapsedMs: Date.now() - start });
}

async function handleNote(args: any, start: number): Promise<string> {
  const { id, note } = args;
  if (!id) throw new Error("id is required for note");
  if (!note || typeof note !== "string") throw new Error("note text is required");

  const store = await loadStore();
  const pos = store.positions.find((p) => p.id === id);
  if (!pos) throw new Error(`Position ${id} not found`);
  if (pos.notes.length >= MAX_NOTES_PER_POSITION) throw new Error(`Max notes (${MAX_NOTES_PER_POSITION}) reached for this position`);

  pos.notes.push({ text: note.slice(0, 500), ts: new Date().toISOString() });
  await saveStore(store);

  return JSON.stringify({ status: "ok", action: "note", id, symbol: pos.symbol, noteCount: pos.notes.length, elapsedMs: Date.now() - start });
}

/* ────────────────────── helpers ────────────────────── */

function formatDuration(ms: number): string {
  if (ms <= 0) return "0s";
  const parts: string[] = [];
  const d = Math.floor(ms / 86400000); if (d) parts.push(`${d}d`);
  const h = Math.floor((ms % 86400000) / 3600000); if (h) parts.push(`${h}h`);
  const m = Math.floor((ms % 3600000) / 60000); if (m) parts.push(`${m}m`);
  if (parts.length === 0) parts.push(`${Math.floor(ms / 1000)}s`);
  return parts.join(" ");
}
