import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, unlinkSync } from "fs";
import path from "path";
import { callLLM } from "../llm/router.js";

const SESSIONS_DIR = path.join(process.cwd(), "sessions");
const MAX_MESSAGES = 40; // summarize when history exceeds this
const MAX_SESSIONS = 200; // evict oldest sessions beyond this
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

function ensureDir() {
  mkdirSync(SESSIONS_DIR, { recursive: true });
}

function sessionPath(sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  return path.join(SESSIONS_DIR, `${safe}.json`);
}

export function loadSession(sessionId: string): Session | null {
  const p = sessionPath(sessionId);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

export function saveSession(session: Session): void {
  ensureDir();
  session.updatedAt = Date.now();
  writeFileSync(sessionPath(session.id), JSON.stringify(session), "utf8");
}

export function createSession(sessionId: string, userId: string): Session {
  return {
    id: sessionId,
    userId,
    summary: "",
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now()
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

  // Take the older half and summarize it
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
    // If summarization fails, just trim the oldest messages
    session.messages = session.messages.slice(cutoff);
  }
}

export function listSessions(userId?: string): string[] {
  ensureDir();
  const files = readdirSync(SESSIONS_DIR).filter(f => f.endsWith(".json"));
  if (!userId) return files.map(f => f.replace(".json", ""));
  return files
    .filter(f => {
      try {
        const s: Session = JSON.parse(readFileSync(path.join(SESSIONS_DIR, f), "utf8"));
        return s.userId === userId;
      } catch { return false; }
    })
    .map(f => f.replace(".json", ""));
}

export function cleanExpiredSessions(): void {
  ensureDir();
  const now = Date.now();
  const files = readdirSync(SESSIONS_DIR).filter(f => f.endsWith(".json"));

  // Remove expired
  for (const f of files) {
    const fp = path.join(SESSIONS_DIR, f);
    try {
      const stat = statSync(fp);
      if (now - stat.mtimeMs > SESSION_TTL_MS) unlinkSync(fp);
    } catch {}
  }

  // Evict oldest if over max
  const remaining = readdirSync(SESSIONS_DIR)
    .filter(f => f.endsWith(".json"))
    .map(f => ({ name: f, mtime: statSync(path.join(SESSIONS_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  if (remaining.length > MAX_SESSIONS) {
    for (const f of remaining.slice(MAX_SESSIONS)) {
      try { unlinkSync(path.join(SESSIONS_DIR, f.name)); } catch {}
    }
  }
}
