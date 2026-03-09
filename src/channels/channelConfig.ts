import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import path from "path";

export interface ChannelConfig {
  telegram?: { botToken: string };
  discord?: { botToken: string };
  slack?: { botToken: string; signingSecret: string };
}

const CONFIG_PATH = path.join(process.cwd(), "config", "channels.json");

let cached: ChannelConfig | null = null;

export function loadChannelConfig(): ChannelConfig {
  if (cached) return cached;
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    cached = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    return cached!;
  } catch {
    return {};
  }
}

export function saveChannelConfig(config: ChannelConfig): void {
  const dir = path.dirname(CONFIG_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf8");
  cached = config;
}

export function clearChannelConfigCache(): void {
  cached = null;
}

export function getMaskedConfig(): Record<string, Record<string, string>> {
  const cfg = loadChannelConfig();
  const mask = (val?: string) => val ? "****" + val.slice(-4) : "";
  return {
    telegram: { botToken: mask(cfg.telegram?.botToken) },
    discord: { botToken: mask(cfg.discord?.botToken) },
    slack: { botToken: mask(cfg.slack?.botToken), signingSecret: mask(cfg.slack?.signingSecret) },
  };
}
