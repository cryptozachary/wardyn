/**
 * Runtime-editable settings. A narrow allow-list of operational env vars can
 * be overridden at runtime via /api/settings; values are stored in the
 * app_settings SQLite table and shadow process.env for the consumers that
 * read them through this module.
 *
 * Lookup order for any key: app_settings row → process.env[key] → default.
 *
 * Only settings that are safe to change *without* a restart belong here.
 * Things like HOST, PORT, rate limits, and body size caps are consumed at
 * boot and require a process restart to take effect — those stay env-only.
 */

import { getDb } from "../db.js";

export interface SettingDef {
  key: string;
  kind: "number" | "string";
  default?: number | string;
  min?: number;
  max?: number;
  description: string;
  /** Human-friendly group for the UI. */
  group: "llm" | "retention";
}

/**
 * Allow-list of runtime-editable settings. The UI and API both gate writes
 * against this list; anything outside it is rejected.
 */
export const SETTING_DEFS: SettingDef[] = [
  {
    key: "LLM_DAILY_BUDGET_USD",
    kind: "number",
    min: 0,
    max: 1_000_000,
    description: "Refuse LLM calls once the last 24h of spend reaches this USD amount. Blank = no cap.",
    group: "llm",
  },
  {
    key: "AUDIT_RETENTION_DAYS",
    kind: "number",
    default: 90,
    min: 1,
    max: 3650,
    description: "Audit events older than this are pruned every 6h. Hash-chain head re-seeds from the newest survivor.",
    group: "retention",
  },
  {
    key: "CANVAS_RETENTION_DAYS",
    kind: "number",
    default: 7,
    min: 1,
    max: 3650,
    description: "Canvas items older than this are pruned every 6h.",
    group: "retention",
  },
  {
    key: "CANVAS_MAX_ITEMS",
    kind: "number",
    default: 5000,
    min: 1,
    max: 10_000_000,
    description: "Hard cap on total canvas rows after the age prune.",
    group: "retention",
  },
];

export function getSettingDef(key: string): SettingDef | undefined {
  return SETTING_DEFS.find(d => d.key === key);
}

function getRaw(key: string): string | undefined {
  try {
    const row = getDb()
      .prepare("SELECT value FROM app_settings WHERE key = ?")
      .get(key) as { value: string } | undefined;
    if (row?.value != null) return row.value;
  } catch {}
  const env = process.env[key];
  if (env != null && env !== "") return env;
  return undefined;
}

/**
 * Read a numeric setting. Returns the default if no override exists and no
 * env value is set. Returns undefined if the setting has no default and no
 * override (e.g. LLM_DAILY_BUDGET_USD "unset means no cap").
 */
export function getSettingNumber(key: string): number | undefined {
  const raw = getRaw(key);
  const def = getSettingDef(key);
  if (raw != null) {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  if (def && typeof def.default === "number") return def.default;
  return undefined;
}

export function getSettingString(key: string): string | undefined {
  return getRaw(key);
}

export function setSetting(key: string, value: string): void {
  const def = getSettingDef(key);
  if (!def) throw new Error(`unknown setting: ${key}`);
  if (def.kind === "number") {
    const n = Number(value);
    if (!Number.isFinite(n)) throw new Error(`${key} must be a finite number`);
    if (def.min != null && n < def.min) throw new Error(`${key} must be >= ${def.min}`);
    if (def.max != null && n > def.max) throw new Error(`${key} must be <= ${def.max}`);
    value = String(n);
  }
  getDb()
    .prepare(
      "INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
    )
    .run(key, value, Date.now());
}

/** Remove the DB override so the env/default takes over again. */
export function deleteSetting(key: string): void {
  if (!getSettingDef(key)) throw new Error(`unknown setting: ${key}`);
  getDb().prepare("DELETE FROM app_settings WHERE key = ?").run(key);
}

export interface EffectiveSetting {
  key: string;
  kind: "number" | "string";
  group: string;
  description: string;
  value: string | number | null;
  source: "db" | "env" | "default" | "unset";
  default: string | number | null;
  min?: number;
  max?: number;
  updatedAt?: number;
}

export function listSettings(): EffectiveSetting[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT key, value, updated_at FROM app_settings")
    .all() as Array<{ key: string; value: string; updated_at: number }>;
  const byKey = new Map(rows.map(r => [r.key, r]));

  return SETTING_DEFS.map(def => {
    const dbRow = byKey.get(def.key);
    const envRaw = process.env[def.key];
    let source: EffectiveSetting["source"];
    let rawValue: string | undefined;
    if (dbRow) { source = "db"; rawValue = dbRow.value; }
    else if (envRaw != null && envRaw !== "") { source = "env"; rawValue = envRaw; }
    else if (def.default != null) { source = "default"; rawValue = String(def.default); }
    else { source = "unset"; rawValue = undefined; }

    let value: string | number | null = rawValue ?? null;
    if (def.kind === "number" && rawValue != null) {
      const n = Number(rawValue);
      value = Number.isFinite(n) ? n : null;
    }
    return {
      key: def.key,
      kind: def.kind,
      group: def.group,
      description: def.description,
      value,
      source,
      default: def.default ?? null,
      min: def.min,
      max: def.max,
      updatedAt: dbRow?.updated_at,
    };
  });
}
