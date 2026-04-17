import { getDb } from "../db.js";
import { callLLM } from "../llm/router.js";
import { encryptPayload, decryptPayload } from "../security/sessionEncryption.js";

const MAX_MESSAGES = 40;
const MAX_SESSIONS = 200;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface SessionMessage {
  role: "user" | "assistant" | "tool" | "system";
  content: string | null;
  tool_calls?: any[];
  tool_call_id?: string;
  ts: number;
}

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
export const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

export interface Session {
  id: string;
  userId: string;
  summary: string;
  messages: SessionMessage[];
  createdAt: number;
  updatedAt: number;
  strategistMode: boolean;
  thinkingLevel: ThinkingLevel;
}

export function loadSession(sessionId: string): Session | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId) as any;
  if (!row) return null;
  let messages: SessionMessage[] = [];
  let summary = row.summary ?? "";
  try {
    messages = JSON.parse(decryptPayload(row.messages));
  } catch {
    messages = [];
  }
  try {
    if (summary) summary = decryptPayload(summary);
  } catch {
    summary = "";
  }
  return {
    id: row.id,
    userId: row.user_id,
    summary,
    messages,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    strategistMode: !!row.strategist_mode,
    thinkingLevel: (row.thinking_level as ThinkingLevel) || "medium",
  };
}

export function saveSession(session: Session): void {
  session.updatedAt = Date.now();
  const db = getDb();
  db.prepare(`
    INSERT INTO sessions (id, user_id, summary, messages, created_at, updated_at, strategist_mode, thinking_level)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      user_id         = excluded.user_id,
      summary         = excluded.summary,
      messages        = excluded.messages,
      updated_at      = excluded.updated_at,
      strategist_mode = excluded.strategist_mode,
      thinking_level  = excluded.thinking_level
  `).run(
    session.id,
    session.userId,
    session.summary ? encryptPayload(session.summary) : "",
    encryptPayload(JSON.stringify(session.messages)),
    session.createdAt,
    session.updatedAt,
    session.strategistMode ? 1 : 0,
    session.thinkingLevel,
  );
}

export function createSession(sessionId: string, userId: string): Session {
  return {
    id: sessionId,
    userId,
    summary: "",
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    strategistMode: false,
    thinkingLevel: (process.env.DEFAULT_THINKING_LEVEL as ThinkingLevel) || "medium",
  };
}

export function setThinkingLevel(sessionId: string, level: ThinkingLevel): Session | null {
  const s = loadSession(sessionId);
  if (!s) return null;
  s.thinkingLevel = level;
  saveSession(s);
  return s;
}

export function getOrCreateSession(sessionId: string, userId: string): Session {
  return loadSession(sessionId) ?? createSession(sessionId, userId);
}

export function appendToSession(session: Session, ...msgs: SessionMessage[]): void {
  session.messages.push(...msgs);
}

export async function compactIfNeeded(session: Session, apiKey: string): Promise<void> {
  if (session.messages.length <= MAX_MESSAGES) return;

  const cutoff = Math.floor(session.messages.length / 2);
  const oldMessages = session.messages.slice(0, cutoff);

  const transcript = oldMessages
    .filter(m => m.content)
    .map(m => `${m.role}: ${(m.content ?? "").slice(0, 300)}`)
    .join("\n");

  try {
    const result = await callLLM({
      messages: [
        { role: "system", content: "Summarize this conversation history into a concise paragraph. Preserve key facts, decisions, and context the user would need to continue the conversation. Do not exceed 200 words." },
        { role: "user", content: (session.summary ? `Previous summary:\n${session.summary}\n\nNew messages:\n` : "") + transcript }
      ]
    }, apiKey);

    session.summary = result.text ?? session.summary;
    session.messages = session.messages.slice(cutoff);
  } catch {
    session.messages = session.messages.slice(cutoff);
  }
}

export interface SessionSearchHit {
  id: string;
  userId: string;
  updatedAt: number;
  matchIn: "summary" | "message";
  snippet: string;
}

/**
 * Search sessions by free-text query. Matches against summary and message content.
 * Uses SQL LIKE — fine for the single-operator scale (low thousands of sessions).
 */
export function searchSessions(query: string, limit = 50, userId?: string): SessionSearchHit[] {
  const q = query.trim();
  if (!q) return [];
  const db = getDb();
  const qLower = q.toLowerCase();

  // Encrypted payloads can't be LIKE-searched at the SQL level — scan recent
  // sessions in app code. Cap the scan window so a large session table
  // doesn't turn every search into a full-table O(n) decrypt.
  const SCAN_CAP = 500;
  const rows = userId
    ? db.prepare(
        "SELECT id, user_id, summary, messages, updated_at FROM sessions " +
        "WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?"
      ).all(userId, SCAN_CAP) as any[]
    : db.prepare(
        "SELECT id, user_id, summary, messages, updated_at FROM sessions " +
        "ORDER BY updated_at DESC LIMIT ?"
      ).all(SCAN_CAP) as any[];

  const hits: SessionSearchHit[] = [];
  for (const r of rows) {
    if (hits.length >= limit) break;

    let summary = "";
    let msgs: SessionMessage[] = [];
    try { summary = r.summary ? decryptPayload(r.summary) : ""; } catch {}
    try { msgs = JSON.parse(decryptPayload(r.messages)); } catch {}

    let matchIn: "summary" | "message" | null = null;
    let snippet = "";
    if (summary && summary.toLowerCase().includes(qLower)) {
      matchIn = "summary";
      snippet = buildSnippet(summary, qLower);
    } else {
      const hit = msgs.find(m => typeof m.content === "string" && m.content.toLowerCase().includes(qLower));
      if (hit && typeof hit.content === "string") {
        matchIn = "message";
        snippet = buildSnippet(hit.content, qLower);
      }
    }

    if (!matchIn) continue;
    hits.push({
      id: r.id,
      userId: r.user_id,
      updatedAt: r.updated_at,
      matchIn,
      snippet,
    });
  }
  return hits;
}

function buildSnippet(text: string, qLower: string, radius = 60): string {
  const idx = text.toLowerCase().indexOf(qLower);
  if (idx < 0) return text.slice(0, radius * 2);
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + qLower.length + radius);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return prefix + text.slice(start, end).replace(/\s+/g, " ").trim() + suffix;
}

export function listSessions(userId?: string): string[] {
  const db = getDb();
  if (!userId) {
    const rows = db.prepare("SELECT id FROM sessions ORDER BY updated_at DESC").all() as any[];
    return rows.map(r => r.id);
  }
  const rows = db.prepare("SELECT id FROM sessions WHERE user_id = ? ORDER BY updated_at DESC").all(userId) as any[];
  return rows.map(r => r.id);
}

export function cleanExpiredSessions(): void {
  const db = getDb();
  const cutoff = Date.now() - SESSION_TTL_MS;

  // Remove expired
  db.prepare("DELETE FROM sessions WHERE updated_at < ?").run(cutoff);

  // Evict oldest if over max
  const count = (db.prepare("SELECT COUNT(*) as cnt FROM sessions").get() as any).cnt;
  if (count > MAX_SESSIONS) {
    db.prepare(`
      DELETE FROM sessions WHERE id IN (
        SELECT id FROM sessions ORDER BY updated_at ASC LIMIT ?
      )
    `).run(count - MAX_SESSIONS);
  }
}
