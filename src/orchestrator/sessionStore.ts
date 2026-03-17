import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, unlinkSync, copyFileSync } from "fs";
import path from "path";
import { callLLM } from "../llm/router.js";
import { signSession, verifySession, validateSessionStructure, repairSession } from "../security/sessionIntegrity.js";
import { encryptSession, decryptSession } from "../security/sessionEncryption.js";

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
  const backupPath = p.replace(".json", ".backup.json");
  let data: any;
  try {
    const raw = readFileSync(p);
    const json = decryptSession(raw);
    data = JSON.parse(json);
  } catch {
    // Primary file corrupted or decryption failed -- try backup
    if (existsSync(backupPath)) {
      try {
        const backupRaw = readFileSync(backupPath);
        const backupJson = decryptSession(backupRaw);
        data = JSON.parse(backupJson);
        console.warn(`[session] Recovered ${sessionId} from backup (primary corrupted)`);
      } catch {
        return null;
      }
    } else {
      return null;
    }
  }

  // Verify HMAC integrity
  const integrity = verifySession(data);
  if (!integrity.valid) {
    console.warn(`[session] Integrity check failed for ${sessionId}: ${integrity.reason}`);
    // Try backup
    if (existsSync(backupPath)) {
      try {
        const backupRaw = readFileSync(backupPath);
        const backupJson = decryptSession(backupRaw);
        const backupData = JSON.parse(backupJson);
        const backupIntegrity = verifySession(backupData);
        if (backupIntegrity.valid) {
          console.warn(`[session] Recovered ${sessionId} from backup (HMAC mismatch on primary)`);
          data = backupData;
        }
      } catch {}
    }
  }

  // Validate structure and repair if needed
  const issues = validateSessionStructure(data);
  if (issues.length > 0) {
    console.warn(`[session] Structure issues in ${sessionId}: ${issues.join(", ")}`);
    const repaired = repairSession(data, sessionId);
    if (!repaired) return null;
    data = repaired;
    // Save repaired version (encrypted)
    const signed = signSession(data);
    writeFileSync(p, encryptSession(JSON.stringify(signed)));
  }

  // Re-sign and encrypt legacy unsigned sessions
  if (integrity.reason === "legacy_unsigned") {
    const signed = signSession(data);
    writeFileSync(p, encryptSession(JSON.stringify(signed)));
  }

  return data as Session;
}

export function saveSession(session: Session): void {
  ensureDir();
  session.updatedAt = Date.now();
  const p = sessionPath(session.id);
  // Create backup of current file before overwriting
  if (existsSync(p)) {
    const backupPath = p.replace(".json", ".backup.json");
    try { copyFileSync(p, backupPath); } catch {}
  }
  const signed = signSession(session as any);
  const encrypted = encryptSession(JSON.stringify(signed));
  writeFileSync(p, encrypted);
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
