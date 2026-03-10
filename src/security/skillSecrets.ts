import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import path from "path";

const SECRETS_PATH = path.join(process.cwd(), "config", "skill-secrets.json");

type SecretsStore = Record<string, Record<string, string>>;

function load(): SecretsStore {
  if (!existsSync(SECRETS_PATH)) return {};
  try {
    return JSON.parse(readFileSync(SECRETS_PATH, "utf8"));
  } catch {
    return {};
  }
}

function save(store: SecretsStore): void {
  const dir = path.dirname(SECRETS_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(SECRETS_PATH, JSON.stringify(store, null, 2), "utf8");
}

/** Get a single secret for a skill. Returns empty string if not set. */
export function getSkillSecret(skillName: string, key: string): string {
  const store = load();
  return (store[skillName]?.[key] ?? "").trim();
}

/** Get all secrets for a skill. */
export function getSkillSecrets(skillName: string): Record<string, string> {
  const store = load();
  return store[skillName] ?? {};
}

/** Set a secret for a skill. */
export function setSkillSecret(skillName: string, key: string, value: string): void {
  const store = load();
  if (!store[skillName]) store[skillName] = {};
  store[skillName][key] = value.trim();
  save(store);
}

/** Delete a secret for a skill. */
export function deleteSkillSecret(skillName: string, key: string): void {
  const store = load();
  if (!store[skillName]) return;
  delete store[skillName][key];
  if (Object.keys(store[skillName]).length === 0) delete store[skillName];
  save(store);
}

/** List all skills that have secrets configured (with key names only, no values). */
export function listSkillSecrets(): Record<string, string[]> {
  const store = load();
  const result: Record<string, string[]> = {};
  for (const [skill, secrets] of Object.entries(store)) {
    result[skill] = Object.keys(secrets);
  }
  return result;
}

/** Get masked view of all secrets (for UI display). */
export function getMaskedSecrets(): Record<string, Record<string, string>> {
  const store = load();
  const masked: Record<string, Record<string, string>> = {};
  for (const [skill, secrets] of Object.entries(store)) {
    masked[skill] = {};
    for (const [key, val] of Object.entries(secrets)) {
      masked[skill][key] = val.length > 4 ? val.slice(0, 4) + "****" : "****";
    }
  }
  return masked;
}
