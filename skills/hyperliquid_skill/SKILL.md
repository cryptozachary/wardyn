# hyperliquid_skill

Trade on Hyperliquid DEX -- spot and perpetual futures.

## Actions

| Action | Description | Required Params |
|--------|-------------|----------------|
| `place_order` | Place a limit or market order | `symbol`, `side`, `size` |
| `cancel_order` | Cancel a specific order | `symbol`, `order_id` |
| `cancel_all` | Cancel all open orders | none |
| `positions` | Get open perpetual positions | none |
| `balances` | Get spot + perp account balances | none |
| `open_orders` | List all open orders | none |
| `order_status` | Check status of a specific order | `order_id` |
| `markets` | List available perp and spot markets | none |
| `prices` | Get all current mid prices | none |
| `set_leverage` | Set leverage for a perp market | `symbol`, `leverage` |
| `transfer` | Transfer USDC between spot and perp | `amount`, `direction` |

## Order Placement Examples

### Market buy 0.01 BTC perpetual
```json
{ "action": "place_order", "symbol": "BTC", "side": "buy", "size": 0.01, "order_type": "market" }
```

### Limit sell 1 ETH perpetual at $3500
```json
{ "action": "place_order", "symbol": "ETH", "side": "sell", "size": 1, "price": 3500, "order_type": "limit" }
```

### Spot buy 100 HYPE
```json
{ "action": "place_order", "symbol": "HYPE", "side": "buy", "size": 100, "order_type": "market", "market_type": "spot" }
```

### Stop loss on BTC at $60,000
```json
{ "action": "place_order", "symbol": "BTC", "side": "sell", "size": 0.01, "trigger_price": 60000, "tp_sl": "sl" }
```

### Set 10x isolated leverage on SOL
```json
{ "action": "set_leverage", "symbol": "SOL", "leverage": 10, "margin_mode": "isolated" }
```

## Secrets Required

| Key | Description |
|-----|-------------|
| `HYPERLIQUID_PRIVATE_KEY` | Ethereum private key for the trading wallet |
| `HYPERLIQUID_WALLET_ADDRESS` | (Optional) Master wallet address if using API agent wallet |

Set via: Setup page > Skill Secrets > hyperliquid_skill

## Parameters

| Param | Type | Description |
|-------|------|-------------|
| `action` | string | Required. One of the actions above. |
| `symbol` | string | Trading symbol: BTC, ETH, SOL, etc. |
| `side` | string | buy or sell |
| `size` | number | Order size in base asset units |
| `price` | number | Limit price (required for limit orders) |
| `order_type` | string | limit (default) or market |
| `tif` | string | Gtc, Ioc, or Alo |
| `reduce_only` | boolean | Reduce-only order (default: false) |
| `market_type` | string | perp (default) or spot |
| `trigger_price` | number | Trigger price for SL/TP |
| `tp_sl` | string | tp (take profit) or sl (stop loss) |
| `order_id` | number | Order ID for cancel/status |
| `leverage` | number | Leverage multiplier (1-200) |
| `margin_mode` | string | cross (default) or isolated |
| `amount` | number | USDC amount for transfers |
| `direction` | string | spot_to_perp or perp_to_spot |
| `wallet_address` | string | Override wallet for info queries |

## Rate Limits

Hyperliquid uses a token bucket: 100 tokens max, 10 tokens/second refill. The SDK handles rate limit waits automatically.
