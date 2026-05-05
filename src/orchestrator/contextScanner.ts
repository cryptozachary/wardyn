import { readdirSync, readFileSync, statSync, existsSync } from "fs";
import path from "path";
import { paths } from "../paths.js";

const SESSIONS_DIR = paths.sessions();
const LOGS_DIR = paths.logs();
const MEMORY_DIR = paths.memory();

export interface ContextSnapshot {
  timestamp: number;
  sessions: SessionSummary[];
  recentLogs: LogEntry[];
  memory: string;
  soul: string;
}

export interface SessionSummary {
  id: string;
  userId: string;
  messageCount: number;
  summary: string;
  lastActivity: number;
  lastUserMessage: string | null;
  lastAssistantMessage: string | null;
  hasErrors: boolean;
}

export interface LogEntry {
  sessionId: string;
  final: string | null;
  toolResults: { name: string; error?: string }[];
  timestamp: number;
}

/**
 * Scan recent sessions and return summaries for sessions active within the window.
 */
function scanSessions(windowMs: number): SessionSummary[] {
  if (!existsSync(SESSIONS_DIR)) return [];
  const now = Date.now();
  const summaries: SessionSummary[] = [];

  for (const file of readdirSync(SESSIONS_DIR).filter(f => f.endsWith(".json"))) {
    try {
      const fp = path.join(SESSIONS_DIR, file);
      const stat = statSync(fp);
      if (now - stat.mtimeMs > windowMs) continue; // skip stale sessions

      const session = JSON.parse(readFileSync(fp, "utf8"));
      const messages = session.messages || [];

      const userMsgs = messages.filter((m: any) => m.role === "user");
      const assistantMsgs = messages.filter((m: any) => m.role === "assistant");
      const hasErrors = messages.some((m: any) =>
        m.role === "assistant" && typeof m.content === "string" && /error|failed|exception/i.test(m.content)
      );

      summaries.push({
        id: session.id || file.replace(".json", ""),
        userId: session.userId || "unknown",
        messageCount: messages.length,
        summary: session.summary || "",
        lastActivity: session.updatedAt || stat.mtimeMs,
        lastUserMessage: userMsgs.length > 0 ? truncate(userMsgs[userMsgs.length - 1].content, 200) : null,
        lastAssistantMessage: assistantMsgs.length > 0 ? truncate(assistantMsgs[assistantMsgs.length - 1].content, 200) : null,
        hasErrors
      });
    } catch {}
  }

  return summaries.sort((a, b) => b.lastActivity - a.lastActivity);
}

/**
 * Scan recent log files for entries within the time window.
 */
function scanLogs(windowMs: number, maxEntries: number = 20): LogEntry[] {
  if (!existsSync(LOGS_DIR)) return [];
  const now = Date.now();
  const entries: LogEntry[] = [];

  const logFiles = readdirSync(LOGS_DIR)
    .filter(f => f.endsWith(".log"))
    .map(f => ({ name: f, mtime: statSync(path.join(LOGS_DIR, f)).mtimeMs }))
    .filter(f => now - f.mtime < windowMs)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 10); // only look at 10 most recent log files

  for (const logFile of logFiles) {
    try {
      const content = readFileSync(path.join(LOGS_DIR, logFile.name), "utf8");
      const lines = content.trim().split("\n").slice(-5); // last 5 entries per file

      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          entries.push({
            sessionId: logFile.name.replace(".log", ""),
            final: truncate(entry.final, 150),
            toolResults: (entry.toolResults || []).map((tr: any) => ({
              name: tr.name,
              error: tr.error || undefined
            })),
            timestamp: logFile.mtime
          });
        } catch {}
      }
    } catch {}
  }

  return entries.sort((a, b) => b.timestamp - a.timestamp).slice(0, maxEntries);
}

/**
 * Load memory and soul files.
 */
function loadMemoryFiles(): { memory: string; soul: string } {
  const memPath = path.join(MEMORY_DIR, "MEMORY.md");
  const soulPath = path.join(MEMORY_DIR, "SOUL.md");
  return {
    memory: existsSync(memPath) ? readFileSync(memPath, "utf8") : "",
    soul: existsSync(soulPath) ? readFileSync(soulPath, "utf8") : ""
  };
}

function truncate(s: string | null | undefined, max: number): string | null {
  if (!s) return null;
  return s.length > max ? s.slice(0, max) + "..." : s;
}

/**
 * Build a full context snapshot for the heartbeat triage.
 * @param windowMs How far back to look (default: 2 hours)
 */
export function scanContext(windowMs: number = 2 * 3_600_000): ContextSnapshot {
  const { memory, soul } = loadMemoryFiles();
  return {
    timestamp: Date.now(),
    sessions: scanSessions(windowMs),
    recentLogs: scanLogs(windowMs),
    memory,
    soul
  };
}

/**
 * Format a context snapshot into a readable string for the triage LLM call.
 */
export function formatSnapshot(snapshot: ContextSnapshot): string {
  const parts: string[] = [];
  const timeStr = new Date(snapshot.timestamp).toISOString();
  parts.push(`Context Snapshot at ${timeStr}`);

  // Sessions
  if (snapshot.sessions.length === 0) {
    parts.push("\n## Recent Sessions\nNo active sessions in the scan window.");
  } else {
    parts.push(`\n## Recent Sessions (${snapshot.sessions.length} active)`);
    for (const s of snapshot.sessions.slice(0, 8)) {
      const ago = Math.round((snapshot.timestamp - s.lastActivity) / 60_000);
      parts.push(`- **${s.id}** (user: ${s.userId}, ${s.messageCount} msgs, ${ago}min ago)${s.hasErrors ? " [HAS ERRORS]" : ""}`);
      if (s.summary) parts.push(`  Summary: ${s.summary.slice(0, 200)}`);
      if (s.lastUserMessage) parts.push(`  Last user: "${s.lastUserMessage}"`);
      if (s.lastAssistantMessage) parts.push(`  Last reply: "${s.lastAssistantMessage}"`);
    }
  }

  // Logs with errors
  const errorLogs = snapshot.recentLogs.filter(l =>
    l.toolResults.some(tr => tr.error)
  );
  if (errorLogs.length > 0) {
    parts.push(`\n## Recent Errors (${errorLogs.length})`);
    for (const l of errorLogs.slice(0, 5)) {
      const errors = l.toolResults.filter(tr => tr.error);
      parts.push(`- Session ${l.sessionId}: ${errors.map(e => `${e.name}: ${e.error}`).join("; ")}`);
    }
  }

  // Tool usage summary
  const toolCounts: Record<string, number> = {};
  for (const l of snapshot.recentLogs) {
    for (const tr of l.toolResults) {
      toolCounts[tr.name] = (toolCounts[tr.name] || 0) + 1;
    }
  }
  if (Object.keys(toolCounts).length > 0) {
    parts.push(`\n## Tool Usage`);
    parts.push(Object.entries(toolCounts).map(([k, v]) => `${k}: ${v}`).join(", "));
  }

  return parts.join("\n");
}
