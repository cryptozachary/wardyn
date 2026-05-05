import { randomBytes, createCipheriv, scryptSync } from "crypto";
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from "fs";
import path from "path";
import { loadKeys, storeKey } from "./keyVault.js";
import { paths } from "../paths.js";

const SKILL_PREFIX = "skill:";
const VAULT_PATH = paths.config("providers.enc");
const LEGACY_PATH = paths.config("skill-secrets.json");

type SecretsStore = Record<string, Record<string, string>>;

// In-memory cache — populated on first access or after writes
let cache: SecretsStore | null = null;

/** Decode vault keys with skill: prefix into nested structure. */
function vaultToStore(vaultKeys: Record<string, string>): SecretsStore {
  const store: SecretsStore = {};
  for (const [k, v] of Object.entries(vaultKeys)) {
    if (!k.startsWith(SKILL_PREFIX)) continue;
    const rest = k.slice(SKILL_PREFIX.length);
    const sep = rest.indexOf(":");
    if (sep < 0) continue;
    const skillName = rest.slice(0, sep);
    const keyName = rest.slice(sep + 1);
    if (!store[skillName]) store[skillName] = {};
    store[skillName][keyName] = v;
  }
  return store;
}

function getPassphrase(): string {
  return process.env.KEY_PASSPHRASE ?? "";
}

function loadFromVault(): SecretsStore {
  if (!existsSync(VAULT_PATH)) return {};
  try {
    return vaultToStore(loadKeys(getPassphrase()));
  } catch {
    return {};
  }
}

function getStore(): SecretsStore {
  if (cache) return cache;
  cache = loadFromVault();
  return cache;
}

/** Rewrite the entire vault with updated payload. */
function rewriteVault(payload: Record<string, string>, passphrase: string): void {
  const dir = path.dirname(VAULT_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const salt = randomBytes(16);
  const key = scryptSync(passphrase, salt, 32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  writeFileSync(VAULT_PATH, Buffer.concat([salt, iv, tag, data]));
}

/** Initialize cache — call at startup after env is loaded. */
export function initSkillSecrets(): void {
  cache = loadFromVault();
}

/** Get a single secret for a skill. Returns empty string if not set. */
export function getSkillSecret(skillName: string, key: string): string {
  const store = getStore();
  return (store[skillName]?.[key] ?? "").trim();
}

/** Get all secrets for a skill. */
export function getSkillSecrets(skillName: string): Record<string, string> {
  const store = getStore();
  return store[skillName] ?? {};
}

/** Set a secret for a skill. Uses passphrase from env or explicit param. */
export function setSkillSecret(skillName: string, key: string, value: string, passphrase?: string): void {
  const pp = passphrase || getPassphrase();
  const vaultKey = `${SKILL_PREFIX}${skillName}:${key}`;
  storeKey(vaultKey, value.trim(), pp);
  cache = null;
}

/** Delete a secret for a skill. */
export function deleteSkillSecret(skillName: string, key: string, passphrase?: string): void {
  const pp = passphrase || getPassphrase();
  if (!existsSync(VAULT_PATH)) return;
  try {
    const all = loadKeys(pp);
    const vaultKey = `${SKILL_PREFIX}${skillName}:${key}`;
    if (!(vaultKey in all)) return;
    delete all[vaultKey];
    rewriteVault(all, pp);
    cache = null;
  } catch {}
}

/** Get masked view of all secrets (for UI display). */
export function getMaskedSecrets(): Record<string, Record<string, string>> {
  const store = getStore();
  const masked: Record<string, Record<string, string>> = {};
  for (const [skill, secrets] of Object.entries(store)) {
    masked[skill] = {};
    for (const [key, val] of Object.entries(secrets)) {
      masked[skill][key] = val.length > 4 ? val.slice(0, 4) + "****" : "****";
    }
  }
  return masked;
}

/** Migrate legacy plaintext skill-secrets.json into the encrypted vault. */
export function migrateLegacySecrets(passphrase?: string): { migrated: number } {
  if (!existsSync(LEGACY_PATH)) return { migrated: 0 };
  const pp = passphrase || getPassphrase();
  try {
    const legacy: SecretsStore = JSON.parse(readFileSync(LEGACY_PATH, "utf8"));
    let count = 0;
    for (const [skill, keys] of Object.entries(legacy)) {
      for (const [key, value] of Object.entries(keys)) {
        storeKey(`${SKILL_PREFIX}${skill}:${key}`, value.trim(), pp);
        count++;
      }
    }
    // Delete plaintext file after successful migration
    unlinkSync(LEGACY_PATH);
    cache = null;
    return { migrated: count };
  } catch {
    return { migrated: 0 };
  }
}
