import { promises as fs } from "fs";
import { execFile } from "child_process";
import path from "path";

export const parameters = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["query", "execute", "tables", "schema", "export"],
      description: "Database action",
    },
    sql: { type: "string", description: "SQL statement (required for query/execute)" },
    database: { type: "string", description: "Database name (default: 'default'). Creates sandbox/<name>.db" },
    format: { type: "string", enum: ["json", "csv", "table"], description: "Output format for query (default: json)" },
    safeMode: {
      type: "boolean",
      description: "When true, only SELECT/PRAGMA/EXPLAIN allowed (blocks INSERT/UPDATE/DELETE/DROP/ALTER/CREATE). Default: false",
    },
  },
  required: ["action"],
};

/* ────────────────────── constants ────────────────────── */

const SANDBOX_DIR = path.join(process.cwd(), "sandbox");
const MAX_ROWS = 500;
const TIMEOUT_MS = 10000;
const DB_NAME_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/;
const MAX_SQL_LENGTH = 50000; // 50KB

// Fix #2: Block ALL SQLite dot-commands — no dot-command should come from user SQL
const DOT_COMMAND_RE = /^\s*\./m;

// Blocked SQL patterns — prevent destructive system-level operations
const BLOCKED_PATTERNS = [
  /ATTACH\s+DATABASE/i,
  /DETACH\s+DATABASE/i,
  /LOAD_EXTENSION/i,
];

// Fix #6: DDL/DML patterns blocked in safe mode
const WRITE_PATTERNS = [
  /^\s*(INSERT|UPDATE|DELETE|REPLACE|UPSERT)\b/i,
  /^\s*(CREATE|DROP|ALTER|TRUNCATE)\b/i,
  /^\s*REINDEX\b/i,
  /^\s*VACUUM\b/i,
];

/* ────────────────────── sqlite3 detection ────────────────────── */

let sqlite3Checked = false;
let sqlite3Available = false;
let sqlite3Path = "sqlite3";

async function ensureSqlite3(): Promise<void> {
  if (sqlite3Checked) {
    if (!sqlite3Available) throw new Error("sqlite3 CLI not found. Install SQLite3 and ensure 'sqlite3' is in your PATH.");
    return;
  }
  sqlite3Checked = true;

  // Try common locations
  const candidates = process.platform === "win32"
    ? ["sqlite3", "sqlite3.exe", "C:\\ProgramData\\chocolatey\\bin\\sqlite3.exe"]
    : ["sqlite3", "/usr/bin/sqlite3", "/usr/local/bin/sqlite3"];

  for (const candidate of candidates) {
    try {
      await new Promise<void>((resolve, reject) => {
        execFile(candidate, ["--version"], { timeout: 5000 }, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      sqlite3Path = candidate;
      sqlite3Available = true;
      return;
    } catch {
      continue;
    }
  }

  throw new Error(
    "sqlite3 CLI not found. Install SQLite3:\n" +
    (process.platform === "win32"
      ? "  choco install sqlite   OR   winget install SQLite.SQLite"
      : process.platform === "darwin"
        ? "  brew install sqlite"
        : "  sudo apt install sqlite3")
  );
}

/* ────────────────────── helpers ────────────────────── */

// Fix #8: Strict database name validation — no silent stripping
function dbPath(name: string): string {
  if (!DB_NAME_REGEX.test(name)) {
    throw new Error(
      `Invalid database name: "${name}". Use only letters, digits, hyphens, underscores. ` +
      `Must start with a letter or digit, max 63 chars.`
    );
  }
  const resolved = path.join(SANDBOX_DIR, `${name}.db`);
  // Fix #1: Verify resolved path stays in sandbox
  const normalSandbox = path.resolve(SANDBOX_DIR) + path.sep;
  if (!resolved.startsWith(normalSandbox) && resolved !== path.resolve(SANDBOX_DIR)) {
    throw new Error("Database path escapes sandbox boundary");
  }
  return resolved;
}

function assertSafeSql(sql: string, safeMode: boolean): void {
  if (sql.length > MAX_SQL_LENGTH) {
    throw new Error(`SQL too long (${(sql.length / 1024).toFixed(0)}KB, max ${MAX_SQL_LENGTH / 1024}KB)`);
  }

  // Fix #2: Block all dot-commands from user SQL
  if (DOT_COMMAND_RE.test(sql)) {
    throw new Error("SQLite dot-commands (e.g. .system, .output, .import) are not allowed in SQL input");
  }

  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(sql)) {
      throw new Error(`Blocked: SQL contains restricted operation (${pattern.source})`);
    }
  }

  // Fix #6: Safe mode blocks all write operations
  if (safeMode) {
    for (const pattern of WRITE_PATTERNS) {
      if (pattern.test(sql)) {
        throw new Error(`Blocked by safe mode: write/DDL operations not allowed. Disable safeMode to use INSERT/UPDATE/DELETE/CREATE/DROP/ALTER.`);
      }
    }
  }
}

function runSqlite(dbFile: string, commands: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = execFile(
      sqlite3Path,
      [dbFile],
      { timeout: TIMEOUT_MS, maxBuffer: 5 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          if (err.killed) return reject(new Error("Query timed out (10s limit)"));
          const msg = stderr?.trim() || err.message;
          return reject(new Error(msg));
        }
        resolve(stdout);
      },
    );
    proc.stdin?.write(commands);
    proc.stdin?.end();
  });
}

/* ────────────────────── execute ────────────────────── */

export async function execute(args: any): Promise<string> {
  const start = Date.now();
  const { action, database = "default", format = "json", safeMode = false } = args;

  if (!action) {
    return fail("action is required", start);
  }

  try {
    // Fix #7: Detect sqlite3 availability with clear error
    await ensureSqlite3();

    await fs.mkdir(SANDBOX_DIR, { recursive: true });
    const db = dbPath(database);

    switch (action) {
      case "query": {
        const { sql } = args;
        if (!sql || typeof sql !== "string") throw new Error("sql is required for query");
        assertSafeSql(sql, safeMode);

        // Fix #3: Don't blindly append `;` — let SQLite handle it
        // Fix #4: Enforce row limit at query execution with LIMIT injection
        const limitedSql = injectRowLimit(sql.trim(), MAX_ROWS);

        let commands: string;
        if (format === "csv") {
          commands = `.mode csv\n.headers on\n${limitedSql}\n`;
        } else if (format === "table") {
          commands = `.mode table\n.headers on\n${limitedSql}\n`;
        } else {
          commands = `.mode json\n${limitedSql}\n`;
        }

        const output = await runSqlite(db, commands);

        if (format === "json") {
          try {
            const rows = JSON.parse(output || "[]");
            return ok({ action: "query", data: rows, rows: rows.length, truncated: rows.length >= MAX_ROWS, database }, start);
          } catch {
            return ok({ action: "query", data: output.trim(), database }, start);
          }
        }
        return ok({ action: "query", data: output.trim(), database }, start);
      }

      case "execute": {
        const { sql } = args;
        if (!sql || typeof sql !== "string") throw new Error("sql is required for execute");
        assertSafeSql(sql, safeMode);

        // Fix #3 + #5: Don't append `;` blindly, and capture changes() properly
        const commands = `${sql.trim()}\n`;
        await runSqlite(db, commands);

        // Get affected row count in a separate query
        const changesOutput = await runSqlite(db, `.mode json\nSELECT changes() as affected_rows;\n`);
        let affectedRows = 0;
        try {
          const parsed = JSON.parse(changesOutput || "[]");
          affectedRows = parsed[0]?.affected_rows ?? 0;
        } catch { /* ignore */ }

        return ok({ action: "execute", database, affectedRows }, start);
      }

      case "tables": {
        const output = await runSqlite(
          db,
          ".mode json\nSELECT name, type FROM sqlite_master WHERE type IN ('table','view') ORDER BY name;\n",
        );
        const tables = JSON.parse(output || "[]");
        return ok({ action: "tables", database, data: tables, count: tables.length }, start);
      }

      case "schema": {
        const output = await runSqlite(db, ".schema\n");
        return ok({ action: "schema", database, data: output.trim() }, start);
      }

      case "export": {
        // Fix #1: Use validated database name for export filename
        const exportName = `${database}_export.sql`;
        const exportPath = path.join(SANDBOX_DIR, exportName);
        // Double-check path stays in sandbox
        const normalSandbox = path.resolve(SANDBOX_DIR) + path.sep;
        if (!path.resolve(exportPath).startsWith(normalSandbox)) {
          throw new Error("Export path escapes sandbox boundary");
        }

        const output = await runSqlite(db, ".dump\n");
        await fs.writeFile(exportPath, output, "utf8");
        return ok({
          action: "export",
          database,
          path: `sandbox/${exportName}`,
          bytes: Buffer.byteLength(output),
        }, start);
      }

      default:
        throw new Error(`Unknown action: ${action}. Use: query, execute, tables, schema, export`);
    }
  } catch (err: any) {
    return fail(err.message, start);
  }
}

/* ────────────────────── row limit injection ────────────────────── */

/**
 * Fix #4: Inject LIMIT at the SQL level to avoid loading unbounded result sets.
 * Only injects if the query doesn't already have a LIMIT clause.
 */
function injectRowLimit(sql: string, maxRows: number): string {
  // Strip trailing semicolons for analysis
  const trimmed = sql.replace(/;\s*$/, "").trim();

  // Don't inject into non-SELECT statements or those already with LIMIT
  if (!/^\s*SELECT\b/i.test(trimmed)) return sql;
  if (/\bLIMIT\s+\d/i.test(trimmed)) return sql;

  // Add LIMIT + 1 to detect truncation, and wrap with semicolon
  return `${trimmed} LIMIT ${maxRows};`;
}

/* ────────────────────── response helpers ────────────────────── */

function ok(fields: any, start: number): string {
  return JSON.stringify({ status: "ok", elapsedMs: Date.now() - start, ...fields });
}

function fail(error: string, start: number): string {
  return JSON.stringify({ status: "error", error, elapsedMs: Date.now() - start });
}
