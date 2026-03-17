import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import path from "path";
import { loadKeys, storeKey } from "../security/keyVault.js";

export interface ChannelConfig {
  telegram?: { botToken: string };
  discord?: { botToken: string };
  slack?: { botToken: string; signingSecret: string };
}

const CONFIG_PATH = path.join(process.cwd(), "config", "channels.json");
const VAULT_PREFIX = "channel:";

let cached: ChannelConfig | null = null;

function getPassphrase(): string {
  return process.env.KEY_PASSPHRASE ?? "";
}

/**
 * Load channel config from encrypted vault first, fall back to legacy plaintext.
 * Secrets in vault are stored as channel:<channel>:<field> keys.
 */
export function loadChannelConfig(): ChannelConfig {
  if (cached) return cached;

  // Try loading from encrypted vault
  const config = loadFromVault();

  // Fall back to legacy plaintext file
  if (!config.telegram && !config.discord && !config.slack) {
    if (existsSync(CONFIG_PATH)) {
      try {
        const legacy = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as ChannelConfig;
        cached = legacy;
        return cached;
      } catch {}
    }
  }

  cached = config;
  return cached;
}

function loadFromVault(): ChannelConfig {
  const pp = getPassphrase();
  if (!pp) return {};
  try {
    const keys = loadKeys(pp);
    const config: ChannelConfig = {};

    if (keys[`${VAULT_PREFIX}telegram:botToken`]) {
      config.telegram = { botToken: keys[`${VAULT_PREFIX}telegram:botToken`] };
    }
    if (keys[`${VAULT_PREFIX}discord:botToken`]) {
      config.discord = { botToken: keys[`${VAULT_PREFIX}discord:botToken`] };
    }
    if (keys[`${VAULT_PREFIX}slack:botToken`]) {
      config.slack = {
        botToken: keys[`${VAULT_PREFIX}slack:botToken`],
        signingSecret: keys[`${VAULT_PREFIX}slack:signingSecret`] ?? "",
      };
    }
    return config;
  } catch {
    return {};
  }
}

/**
 * Save channel config to encrypted vault AND update legacy file (masked).
 * The plaintext file now only stores masked values for UI display reference.
 */
export function saveChannelConfig(config: ChannelConfig): void {
  const pp = getPassphrase();
  const dir = path.dirname(CONFIG_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  // Store secrets in encrypted vault
  if (pp) {
    if (config.telegram?.botToken) {
      storeKey(`${VAULT_PREFIX}telegram:botToken`, config.telegram.botToken, pp);
    }
    if (config.discord?.botToken) {
      storeKey(`${VAULT_PREFIX}discord:botToken`, config.discord.botToken, pp);
    }
    if (config.slack?.botToken) {
      storeKey(`${VAULT_PREFIX}slack:botToken`, config.slack.botToken, pp);
      if (config.slack.signingSecret) {
        storeKey(`${VAULT_PREFIX}slack:signingSecret`, config.slack.signingSecret, pp);
      }
    }
  }

  // Write masked version to plaintext file (safe to commit)
  const mask = (val?: string) => val ? "****" + val.slice(-4) : "";
  const masked = {
    telegram: config.telegram ? { botToken: mask(config.telegram.botToken) } : undefined,
    discord: config.discord ? { botToken: mask(config.discord.botToken) } : undefined,
    slack: config.slack ? {
      botToken: mask(config.slack.botToken),
      signingSecret: mask(config.slack.signingSecret),
    } : undefined,
  };
  writeFileSync(CONFIG_PATH, JSON.stringify(masked, null, 2), "utf8");

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

/**
 * Migrate legacy plaintext channels.json into encrypted vault.
 * Returns count of secrets migrated.
 */
export function migrateChannelSecrets(): { migrated: number } {
  if (!existsSync(CONFIG_PATH)) return { migrated: 0 };
  const pp = getPassphrase();
  if (!pp) return { migrated: 0 };

  try {
    const raw = readFileSync(CONFIG_PATH, "utf8");
    const legacy = JSON.parse(raw) as ChannelConfig;
    let count = 0;

    // Only migrate if values look like real tokens (not masked)
    if (legacy.telegram?.botToken && !legacy.telegram.botToken.startsWith("****")) {
      storeKey(`${VAULT_PREFIX}telegram:botToken`, legacy.telegram.botToken, pp);
      count++;
    }
    if (legacy.discord?.botToken && !legacy.discord.botToken.startsWith("****")) {
      storeKey(`${VAULT_PREFIX}discord:botToken`, legacy.discord.botToken, pp);
      count++;
    }
    if (legacy.slack?.botToken && !legacy.slack.botToken.startsWith("****")) {
      storeKey(`${VAULT_PREFIX}slack:botToken`, legacy.slack.botToken, pp);
      count++;
      if (legacy.slack.signingSecret && !legacy.slack.signingSecret.startsWith("****")) {
        storeKey(`${VAULT_PREFIX}slack:signingSecret`, legacy.slack.signingSecret, pp);
        count++;
      }
    }

    if (count > 0) {
      // Replace plaintext file with masked version
      const mask = (val?: string) => val ? "****" + val.slice(-4) : "";
      const masked = {
        telegram: legacy.telegram ? { botToken: mask(legacy.telegram.botToken) } : undefined,
        discord: legacy.discord ? { botToken: mask(legacy.discord.botToken) } : undefined,
        slack: legacy.slack ? {
          botToken: mask(legacy.slack.botToken),
          signingSecret: mask(legacy.slack.signingSecret),
        } : undefined,
      };
      writeFileSync(CONFIG_PATH, JSON.stringify(masked, null, 2), "utf8");
      cached = null;
    }

    return { migrated: count };
  } catch {
    return { migrated: 0 };
  }
}
