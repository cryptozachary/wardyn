/**
 * Hyperliquid Exchange Skill -- spot and perpetual trading on Hyperliquid DEX.
 *
 * Supports: placing orders (market/limit), cancelling orders, getting positions,
 * balances, open orders, market prices, setting leverage, and transferring
 * between spot and perp accounts.
 *
 * Requires secrets: HYPERLIQUID_PRIVATE_KEY (wallet private key)
 * Optional: HYPERLIQUID_WALLET_ADDRESS (for API agent wallets)
 */

// @ts-ignore -- hyperliquid SDK
import { Hyperliquid } from "hyperliquid";

export const parameters = {
  type: "object" as const,
  properties: {
    action: {
      type: "string",
      enum: [
        "place_order", "cancel_order", "cancel_all",
        "positions", "balances", "open_orders", "order_status",
        "markets", "prices", "set_leverage", "transfer",
      ],
      description:
        "Action: place_order (limit/market), cancel_order (by oid), cancel_all (all open), " +
        "positions (open perp positions), balances (spot + perp balances), open_orders, " +
        "order_status (by oid), markets (available assets), prices (all mid prices), " +
        "set_leverage (perp leverage), transfer (between spot and perp).",
    },

    // -- Order placement --
    symbol: {
      type: "string",
      description: "Trading symbol. Perps: 'BTC', 'ETH', 'SOL'. Spot: 'PURR', 'HYPE'. Case-insensitive.",
    },
    side: {
      type: "string",
      enum: ["buy", "sell"],
      description: "Order side: buy or sell.",
    },
    size: {
      type: "number",
      description: "Order size in base asset units (e.g., 0.01 for BTC).",
    },
    price: {
      type: "number",
      description: "Limit price. Required for limit orders. For market orders, omit or set to 0.",
    },
    order_type: {
      type: "string",
      enum: ["limit", "market"],
      description: "Order type (default: limit). Market orders use IOC.",
    },
    tif: {
      type: "string",
      enum: ["Gtc", "Ioc", "Alo"],
      description: "Time-in-force: Gtc (good-til-cancel), Ioc (immediate-or-cancel/market), Alo (post-only). Default: Gtc for limit, Ioc for market.",
    },
    reduce_only: {
      type: "boolean",
      description: "Reduce-only order (default: false).",
    },
    market_type: {
      type: "string",
      enum: ["perp", "spot"],
      description: "Market type: perp (perpetual futures) or spot. Default: perp.",
    },

    // -- Stop loss / take profit --
    trigger_price: {
      type: "number",
      description: "Trigger price for stop-loss or take-profit orders.",
    },
    tp_sl: {
      type: "string",
      enum: ["tp", "sl"],
      description: "Trigger type: tp (take profit) or sl (stop loss). Required with trigger_price.",
    },

    // -- Cancel --
    order_id: {
      type: "number",
      description: "Order ID to cancel or check status.",
    },

    // -- Leverage --
    leverage: {
      type: "number",
      description: "Leverage multiplier (1-200 depending on asset).",
    },
    margin_mode: {
      type: "string",
      enum: ["cross", "isolated"],
      description: "Margin mode: cross or isolated. Default: cross.",
    },

    // -- Transfer --
    amount: {
      type: "number",
      description: "USDC amount to transfer between spot and perp.",
    },
    direction: {
      type: "string",
      enum: ["spot_to_perp", "perp_to_spot"],
      description: "Transfer direction.",
    },

    // -- General --
    wallet_address: {
      type: "string",
      description: "Override wallet address for info queries. Uses configured address by default.",
    },
  },
  required: ["action"],
};

// Lazy-init SDK instance
let sdk: any = null;
let sdkAddress: string = "";

function getSecret(name: string): string {
  try {
    // Try skill secrets system first
    const mod = require("../src/security/skillSecrets.js");
    const val = mod.getSkillSecret("hyperliquid_skill", name);
    if (val) return val;
  } catch {}
  // Fall back to env
  return process.env[name] ?? "";
}

async function initSDK(): Promise<{ sdk: any; address: string }> {
  if (sdk) return { sdk, address: sdkAddress };

  const privateKey = getSecret("HYPERLIQUID_PRIVATE_KEY");
  if (!privateKey) {
    throw new Error(
      "HYPERLIQUID_PRIVATE_KEY not configured. Set it via: " +
      "skill secrets (hyperliquid_skill -> HYPERLIQUID_PRIVATE_KEY) or .env"
    );
  }

  const walletAddress = getSecret("HYPERLIQUID_WALLET_ADDRESS") || undefined;

  sdk = new Hyperliquid({
    privateKey,
    testnet: false,
    walletAddress,
    enableWs: false, // REST only for skill calls
  });

  // Connect to load asset maps
  await sdk.connect();

  // Derive address from private key
  const { ethers } = await import("ethers");
  const wallet = new ethers.Wallet(privateKey);
  sdkAddress = walletAddress || wallet.address;

  return { sdk, address: sdkAddress };
}

function r(n: number | null | undefined, dec = 6): number | null {
  if (n === null || n === undefined) return null;
  if (n === 0) return 0;
  return Math.round(n * 10 ** dec) / 10 ** dec;
}

// =================== Handlers ===================

async function handlePlaceOrder(args: any): Promise<string> {
  const { sdk, address } = await initSDK();
  const symbol = (args.symbol ?? "").toUpperCase();
  if (!symbol) throw new Error("symbol is required for place_order");
  if (!args.side) throw new Error("side (buy/sell) is required");
  if (!args.size || args.size <= 0) throw new Error("size must be > 0");

  const isBuy = args.side === "buy";
  const isMarket = args.order_type === "market";
  const isSpot = args.market_type === "spot";
  const reduceOnly = args.reduce_only ?? false;

  // For market orders we need to get current price and add slippage
  let limitPx = args.price;
  if (isMarket || !limitPx) {
    const mids = await sdk.info.getAllMids();
    const coin = isSpot ? `${symbol}-SPOT` : symbol;
    const mid = parseFloat(mids[coin] || mids[symbol] || "0");
    if (!mid) throw new Error(`Cannot find price for ${symbol}. Check symbol name.`);
    // 0.5% slippage for market orders
    limitPx = isBuy ? mid * 1.005 : mid * 0.995;
    // Round to reasonable precision
    limitPx = parseFloat(limitPx.toPrecision(6));
  }

  const tif = args.tif ?? (isMarket ? "Ioc" : "Gtc");

  // Build order params
  const coin = isSpot ? `${symbol}-SPOT` : `${symbol}-PERP`;

  let orderResult: any;

  if (args.trigger_price && args.tp_sl) {
    // Trigger order (SL/TP)
    orderResult = await sdk.exchange.placeOrder({
      coin,
      is_buy: isBuy,
      sz: args.size,
      limit_px: limitPx,
      order_type: {
        trigger: {
          isMarket: true,
          triggerPx: args.trigger_price.toString(),
          tpsl: args.tp_sl,
        },
      },
      reduce_only: true,
    });
  } else {
    orderResult = await sdk.exchange.placeOrder({
      coin,
      is_buy: isBuy,
      sz: args.size,
      limit_px: limitPx,
      order_type: { limit: { tif } },
      reduce_only: reduceOnly,
    });
  }

  const status = orderResult?.response?.data?.statuses?.[0];
  if (!status) return JSON.stringify({ ok: true, raw: orderResult });

  if (status.error) {
    return JSON.stringify({ ok: false, error: status.error });
  }

  if (status.filled) {
    return JSON.stringify({
      ok: true,
      status: "filled",
      orderId: status.filled.oid,
      filledSize: status.filled.totalSz,
      avgPrice: status.filled.avgPx,
      symbol,
      side: args.side,
      type: isMarket ? "market" : "limit",
      market: isSpot ? "spot" : "perp",
    });
  }

  if (status.resting) {
    return JSON.stringify({
      ok: true,
      status: "resting",
      orderId: status.resting.oid,
      symbol,
      side: args.side,
      price: limitPx,
      size: args.size,
      type: "limit",
      market: isSpot ? "spot" : "perp",
    });
  }

  return JSON.stringify({ ok: true, status, symbol });
}

async function handleCancelOrder(args: any): Promise<string> {
  const { sdk } = await initSDK();
  if (!args.order_id) throw new Error("order_id is required");
  if (!args.symbol) throw new Error("symbol is required");

  const coin = args.market_type === "spot"
    ? `${args.symbol.toUpperCase()}-SPOT`
    : `${args.symbol.toUpperCase()}-PERP`;

  const result = await sdk.exchange.cancelOrder({ coin, o: args.order_id });
  return JSON.stringify({ ok: true, cancelled: args.order_id, result });
}

async function handleCancelAll(args: any): Promise<string> {
  const { sdk, address } = await initSDK();

  const openOrders = await sdk.info.getUserOpenOrders(address);
  if (!openOrders || openOrders.length === 0) {
    return JSON.stringify({ ok: true, cancelled: 0, message: "No open orders" });
  }

  let cancelled = 0;
  const errors: string[] = [];

  for (const order of openOrders) {
    try {
      await sdk.exchange.cancelOrder({ coin: order.coin, o: order.oid });
      cancelled++;
    } catch (err: any) {
      errors.push(`${order.coin} #${order.oid}: ${err.message}`);
    }
  }

  return JSON.stringify({
    ok: true,
    cancelled,
    total: openOrders.length,
    errors: errors.length > 0 ? errors : undefined,
  });
}

async function handlePositions(args: any): Promise<string> {
  const { sdk, address } = await initSDK();
  const addr = args.wallet_address || address;

  const state = await sdk.info.perpetuals.getClearinghouseState(addr);

  const positions = (state.assetPositions ?? [])
    .filter((p: any) => p.position && parseFloat(p.position.szi) !== 0)
    .map((p: any) => ({
      symbol: p.position.coin,
      side: parseFloat(p.position.szi) > 0 ? "long" : "short",
      size: Math.abs(parseFloat(p.position.szi)),
      entryPrice: r(parseFloat(p.position.entryPx)),
      markPrice: r(parseFloat(p.position.positionValue) / Math.abs(parseFloat(p.position.szi))),
      unrealizedPnl: r(parseFloat(p.position.unrealizedPnl), 2),
      returnOnEquity: r(parseFloat(p.position.returnOnEquity) * 100, 2),
      leverage: p.position.leverage?.value ?? null,
      marginMode: p.position.leverage?.type ?? null,
      liquidationPrice: r(parseFloat(p.position.liquidationPx)),
      marginUsed: r(parseFloat(p.position.marginUsed), 2),
    }));

  const margin = state.marginSummary ?? {};

  return JSON.stringify({
    ok: true,
    positions,
    account: {
      accountValue: r(parseFloat(margin.accountValue), 2),
      totalMarginUsed: r(parseFloat(margin.totalMarginUsed), 2),
      totalNotional: r(parseFloat(margin.totalNtlPos), 2),
      withdrawable: r(parseFloat(margin.withdrawable), 2),
    },
  });
}

async function handleBalances(args: any): Promise<string> {
  const { sdk, address } = await initSDK();
  const addr = args.wallet_address || address;

  // Perp balances
  const perpState = await sdk.info.perpetuals.getClearinghouseState(addr);
  const margin = perpState.marginSummary ?? {};

  // Spot balances
  let spotBalances: any[] = [];
  try {
    const spotState = await sdk.info.spot.getSpotClearinghouseState(addr);
    spotBalances = (spotState.balances ?? [])
      .filter((b: any) => parseFloat(b.total) > 0)
      .map((b: any) => ({
        coin: b.coin,
        total: r(parseFloat(b.total)),
        hold: r(parseFloat(b.hold)),
        available: r(parseFloat(b.total) - parseFloat(b.hold)),
      }));
  } catch {}

  return JSON.stringify({
    ok: true,
    perp: {
      accountValue: r(parseFloat(margin.accountValue), 2),
      totalMarginUsed: r(parseFloat(margin.totalMarginUsed), 2),
      withdrawable: r(parseFloat(margin.withdrawable), 2),
    },
    spot: spotBalances,
  });
}

async function handleOpenOrders(args: any): Promise<string> {
  const { sdk, address } = await initSDK();
  const addr = args.wallet_address || address;

  const orders = await sdk.info.getUserOpenOrders(addr);

  const formatted = (orders ?? []).map((o: any) => ({
    orderId: o.oid,
    symbol: o.coin,
    side: o.side === "B" ? "buy" : "sell",
    price: o.limitPx,
    size: o.sz,
    filled: o.origSz ? r(parseFloat(o.origSz) - parseFloat(o.sz)) : null,
    timestamp: o.timestamp,
  }));

  return JSON.stringify({ ok: true, orders: formatted, count: formatted.length });
}

async function handleOrderStatus(args: any): Promise<string> {
  const { sdk, address } = await initSDK();
  if (!args.order_id) throw new Error("order_id is required");

  const addr = args.wallet_address || address;
  const status = await sdk.info.getOrderStatus(addr, args.order_id);

  return JSON.stringify({ ok: true, ...status });
}

async function handleMarkets(_args: any): Promise<string> {
  const { sdk } = await initSDK();

  const meta = await sdk.info.perpetuals.getMeta();
  const perpMarkets = (meta.universe ?? []).map((a: any) => ({
    symbol: a.name,
    type: "perp",
    maxLeverage: a.maxLeverage,
    szDecimals: a.szDecimals,
  }));

  let spotMarkets: any[] = [];
  try {
    const spotMeta = await sdk.info.spot.getSpotMeta();
    spotMarkets = (spotMeta.universe ?? []).map((p: any) => ({
      symbol: p.name,
      type: "spot",
      tokens: p.tokens,
    }));
  } catch {}

  return JSON.stringify({
    ok: true,
    perp: { count: perpMarkets.length, markets: perpMarkets },
    spot: { count: spotMarkets.length, markets: spotMarkets },
  });
}

async function handlePrices(_args: any): Promise<string> {
  const { sdk } = await initSDK();
  const mids = await sdk.info.getAllMids();

  // Separate perp and spot
  const perp: Record<string, string> = {};
  const spot: Record<string, string> = {};

  for (const [key, val] of Object.entries(mids)) {
    if (typeof val === "string") {
      if (key.includes("-SPOT") || key.includes("/")) {
        spot[key] = val;
      } else {
        perp[key] = val;
      }
    }
  }

  return JSON.stringify({ ok: true, perp, spot });
}

async function handleSetLeverage(args: any): Promise<string> {
  const { sdk, address } = await initSDK();
  if (!args.symbol) throw new Error("symbol is required");
  if (!args.leverage || args.leverage < 1) throw new Error("leverage must be >= 1");

  const symbol = args.symbol.toUpperCase();
  const coin = `${symbol}-PERP`;
  const isCross = (args.margin_mode ?? "cross") === "cross";

  const result = await sdk.exchange.updateLeverage({
    asset: coin,
    isCross,
    leverage: args.leverage,
  });

  // Look up current position to show updated liquidation price
  let position: any = null;
  try {
    const state = await sdk.info.perpetuals.getClearinghouseState(address);
    const pos = (state.assetPositions ?? []).find(
      (p: any) => p.position?.coin === symbol && parseFloat(p.position?.szi) !== 0
    );
    if (pos) {
      const szi = parseFloat(pos.position.szi);
      position = {
        side: szi > 0 ? "long" : "short",
        size: Math.abs(szi),
        entryPrice: r(parseFloat(pos.position.entryPx)),
        liquidationPrice: r(parseFloat(pos.position.liquidationPx)),
        marginUsed: r(parseFloat(pos.position.marginUsed), 2),
        unrealizedPnl: r(parseFloat(pos.position.unrealizedPnl), 2),
      };
    }
  } catch {}

  return JSON.stringify({
    ok: true,
    symbol,
    leverage: args.leverage,
    marginMode: isCross ? "cross" : "isolated",
    position,
    result,
  });
}

async function handleTransfer(args: any): Promise<string> {
  const { sdk } = await initSDK();
  if (!args.amount || args.amount <= 0) throw new Error("amount must be > 0");
  if (!args.direction) throw new Error("direction is required (spot_to_perp or perp_to_spot)");

  const toPerp = args.direction === "spot_to_perp";

  const result = await sdk.exchange.transferBetweenSpotAndPerp({
    amount: args.amount.toString(),
    toPerp,
  });

  return JSON.stringify({
    ok: true,
    transferred: args.amount,
    direction: args.direction,
    result,
  });
}

// =================== Trade Safety Gate ===================

/**
 * Actions that modify state or move funds require confirmation.
 * Read-only actions (positions, balances, prices, etc.) are always allowed.
 *
 * Set HYPERLIQUID_CONFIRM_TRADES=false to disable the gate (not recommended).
 * Autonomous callers (heartbeat, cron) are blocked unless explicitly allowed
 * via HYPERLIQUID_ALLOW_AUTONOMOUS=true.
 */

const WRITE_ACTIONS = new Set([
  "place_order", "cancel_order", "cancel_all",
  "set_leverage", "transfer",
]);

const READ_ACTIONS = new Set([
  "positions", "balances", "open_orders", "order_status",
  "markets", "prices",
]);

function isTradeGateEnabled(): boolean {
  return process.env.HYPERLIQUID_CONFIRM_TRADES !== "false";
}

function isAutonomousAllowed(): boolean {
  return process.env.HYPERLIQUID_ALLOW_AUTONOMOUS === "true";
}

function assertTradeAllowed(action: string, args: any): void {
  if (!WRITE_ACTIONS.has(action)) return; // read-only, always OK
  if (!isTradeGateEnabled()) return; // gate disabled

  // Block autonomous execution (heartbeat/cron) unless explicitly allowed
  // The agent loop passes the channel in the message context
  // When called from heartbeat, there's no interactive user to confirm
  if (!isAutonomousAllowed()) {
    // Check if this is likely an autonomous call by looking at common markers
    // Heartbeat jobs set channel to "heartbeat", cron jobs to "heartbeat" as well
    const caller = args._caller ?? args._channel ?? "";
    if (caller === "heartbeat" || caller === "cron") {
      throw new Error(
        `Trade action "${action}" blocked: autonomous trading is disabled. ` +
        `Set HYPERLIQUID_ALLOW_AUTONOMOUS=true to enable heartbeat/cron trading.`
      );
    }
  }
}

// =================== Main Execute ===================

export async function execute(args: any): Promise<string> {
  const action = args.action;

  if (!READ_ACTIONS.has(action) && !WRITE_ACTIONS.has(action)) {
    throw new Error(`Unknown action: ${action}. Available: place_order, cancel_order, cancel_all, positions, balances, open_orders, order_status, markets, prices, set_leverage, transfer`);
  }

  // Enforce trade safety gate
  assertTradeAllowed(action, args);

  switch (action) {
    case "place_order": return handlePlaceOrder(args);
    case "cancel_order": return handleCancelOrder(args);
    case "cancel_all": return handleCancelAll(args);
    case "positions": return handlePositions(args);
    case "balances": return handleBalances(args);
    case "open_orders": return handleOpenOrders(args);
    case "order_status": return handleOrderStatus(args);
    case "markets": return handleMarkets(args);
    case "prices": return handlePrices(args);
    case "set_leverage": return handleSetLeverage(args);
    case "transfer": return handleTransfer(args);
    default:
      throw new Error(`Unknown action: ${action}`);
  }
}
