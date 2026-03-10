import axios from 'axios';
import { getSkillSecret } from '../../src/security/skillSecrets.js';

export const secrets = {
  TAAPI_API_KEY: { description: 'API key from taapi.io', required: true }
};

export const parameters = {
  type: 'object',
  properties: {
    symbol: { type: 'string', description: 'Symbol (e.g., BTC/USDT for crypto or AAPL for stocks).' },
    assetType: { type: 'string', enum: ['crypto', 'stocks'], description: 'The asset class. Default: crypto.' },
    exchange: { type: 'string', description: 'Exchange for crypto (e.g., binance, binancefutures, bitstamp). Ignored for stocks.' },
    interval: { type: 'string', description: 'Time interval: 1m, 5m, 15m, 30m, 1h, 2h, 4h, 12h, 1d, 1w.' }
  },
  required: ['symbol']
};

export async function execute(args: any): Promise<string> {
  const symbol = (args.symbol || '').toUpperCase();
  const assetType = args.assetType || 'crypto';
  const exchange = args.exchange || 'binance';
  const interval = args.interval || '1d';
  const apiKey = getSkillSecret('taapi_io_price_retriever_skill', 'TAAPI_API_KEY');

  if (!apiKey) throw new Error('TAAPI_API_KEY not configured. Add it in Setup > Skill Secrets.');

  const params: Record<string, string> = {
    secret: apiKey,
    symbol,
    interval,
  };

  if (assetType === 'stocks') {
    params.type = 'stocks';
  } else {
    params.exchange = exchange;
  }

  try {
    const response = await axios.get('https://api.taapi.io/price', { params });

    if (response.data?.error) throw new Error(response.data.error);

    return JSON.stringify({
      asset: symbol,
      type: assetType,
      price: response.data.value,
      timestamp: new Date().toISOString()
    });
  } catch (error: any) {
    const apiError = error.response?.data?.error || error.response?.data?.errors || error.message;
    throw new Error(`Taapi Error: ${typeof apiError === 'object' ? JSON.stringify(apiError) : apiError}`);
  }
}
