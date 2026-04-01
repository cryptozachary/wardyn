import { getDb } from "../db.js";
import { callLLM } from "../llm/router.js";

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

export interface Session {
  id: string;
  userId: string;
  summary: string;
  messages: SessionMessage[];
  createdAt: number;
  updatedAt: number;
}

export function loadSession(sessionId: string): Session | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId) as any;
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    summary: row.summary,
    messages: JSON.parse(row.messages),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function saveSession(session: Session): void {
  session.updatedAt = Date.now();
  const db = getDb();
  db.prepare(`
    INSERT INTO sessions (id, user_id, summary, messages, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      user_id    = excluded.user_id,
      summary    = excluded.summary,
      messages   = excluded.messages,
      updated_at = excluded.updated_at
  `).run(
    session.id,
    session.userId,
    session.summary,
    JSON.stringify(session.messages),
    session.createdAt,
    session.updatedAt,
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
  };
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
