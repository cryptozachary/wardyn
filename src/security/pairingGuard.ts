/**
 * Pairing guard for inbound DMs.
 *
 * Unknown external IDs (Telegram chat_id, Discord channel_id, Slack user_id,
 * WhatsApp jid) must be explicitly paired before the agent will respond. Each
 * unknown sender receives a 6-char code in-channel; the operator approves via
 * `POST /api/pairings/approve` or the `myclaw pair` CLI.
 *
 * Bypass: set env `PAIRING_DISABLED=1` to keep legacy behavior.
 */
import { getDb } from "../db.js";
import { randomBytes } from "crypto";

export type Channel = "telegram" | "discord" | "slack" | "whatsapp";

export interface Pairing {
  channel: Channel;
  externalId: string;
  code: string | null;
  approvedAt: number | null;
  createdAt: number;
  lastSeenAt: number;
}

function ensureTable(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS pairings (
      channel       TEXT NOT NULL,
      external_id   TEXT NOT NULL,
      code          TEXT,
      approved_at   INTEGER,
      created_at    INTEGER NOT NULL,
      last_seen_at  INTEGER NOT NULL,
      PRIMARY KEY (channel, external_id)
    );
    CREATE INDEX IF NOT EXISTS idx_pairings_code ON pairings(code);
  `);
}

function genCode(): string {
  return randomBytes(3).toString("hex").toUpperCase(); // 6 chars
}

export function isPairingEnabled(): boolean {
  return process.env.PAIRING_DISABLED !== "1";
}

/**
 * Check if a sender is approved. Returns:
 *   - { approved: true }                         → hand message to agent
 *   - { approved: false, code, isNew }           → reply with pairing instructions
 */
export function checkPairing(
  channel: Channel,
  externalId: string
): { approved: boolean; code?: string; isNew?: boolean } {
  if (!isPairingEnabled()) return { approved: true };
  ensureTable();

  const db = getDb();
  const now = Date.now();
  const row = db
    .prepare("SELECT * FROM pairings WHERE channel = ? AND external_id = ?")
    .get(channel, externalId) as any;

  if (row?.approved_at) {
    db.prepare(
      "UPDATE pairings SET last_seen_at = ? WHERE channel = ? AND external_id = ?"
    ).run(now, channel, externalId);
    return { approved: true };
  }

  if (row?.code) {
    db.prepare(
      "UPDATE pairings SET last_seen_at = ? WHERE channel = ? AND external_id = ?"
    ).run(now, channel, externalId);
    return { approved: false, code: row.code, isNew: false };
  }

  const code = genCode();
  db.prepare(
    `INSERT INTO pairings (channel, external_id, code, approved_at, created_at, last_seen_at)
     VALUES (?, ?, ?, NULL, ?, ?)`
  ).run(channel, externalId, code, now, now);
  return { approved: false, code, isNew: true };
}

export function pairingMessage(channel: Channel, code: string): string {
  return [
    "This agent requires pairing before it will respond.",
    `Pairing code: ${code}`,
    `Ask the operator to run:  myclaw pair approve ${channel} ${code}`,
    "(or approve via the Setup page).",
  ].join("\n");
}

export function approveByCode(code: string): Pairing | null {
  ensureTable();
  const db = getDb();
  const norm = code.trim().toUpperCase();
  const row = db
    .prepare("SELECT * FROM pairings WHERE code = ? AND approved_at IS NULL")
    .get(norm) as any;
  if (!row) return null;
  const now = Date.now();
  db.prepare(
    "UPDATE pairings SET approved_at = ?, code = NULL WHERE channel = ? AND external_id = ?"
  ).run(now, row.channel, row.external_id);
  return mapRow({ ...row, approved_at: now, code: null });
}

export function approve(channel: Channel, externalId: string): Pairing {
  ensureTable();
  const db = getDb();
  const now = Date.now();
  const existing = db
    .prepare("SELECT * FROM pairings WHERE channel = ? AND external_id = ?")
    .get(channel, externalId) as any;
  if (existing) {
    db.prepare(
      "UPDATE pairings SET approved_at = ?, code = NULL WHERE channel = ? AND external_id = ?"
    ).run(now, channel, externalId);
  } else {
    db.prepare(
      `INSERT INTO pairings (channel, external_id, code, approved_at, created_at, last_seen_at)
       VALUES (?, ?, NULL, ?, ?, ?)`
    ).run(channel, externalId, now, now, now);
  }
  return mapRow(
    db.prepare("SELECT * FROM pairings WHERE channel = ? AND external_id = ?")
      .get(channel, externalId)
  );
}

export function revoke(channel: Channel, externalId: string): boolean {
  ensureTable();
  const db = getDb();
  const r = db
    .prepare("DELETE FROM pairings WHERE channel = ? AND external_id = ?")
    .run(channel, externalId);
  return r.changes > 0;
}

export function listPairings(): Pairing[] {
  ensureTable();
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM pairings ORDER BY last_seen_at DESC")
    .all() as any[];
  return rows.map(mapRow);
}

function mapRow(r: any): Pairing {
  return {
    channel: r.channel,
    externalId: r.external_id,
    code: r.code ?? null,
    approvedAt: r.approved_at ?? null,
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
  };
}
