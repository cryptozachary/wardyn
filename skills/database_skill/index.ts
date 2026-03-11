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
  },
  required: ["action"],
};

/* ────────────────────── constants ────────────────────── */

const SANDBOX_DIR = path.join(process.cwd(), "sandbox");
const MAX_ROWS = 500;
const TIMEOUT_MS = 10000;

// Blocked SQL patterns — prevent destructive system-level operations
const BLOCKED_PATTERNS = [
  /ATTACH\s+DATABASE/i,
  /LOAD_EXTENSION/i,
  /\.system/i,
  /\.shell/i,
];

/* ────────────────────── helpers ────────────────────── */

function dbPath(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, "");
  if (!sanitized) throw new Error("Invalid database name");
  return path.join(SANDBOX_DIR, `${sanitized}.db`);
}

function assertSafeSql(sql: string): void {
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(sql)) {
      throw new Error(`Blocked: SQL contains restricted operation (${pattern.source})`);
    }
  }
}

function runSqlite(dbFile: string, commands: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = execFile(
      "sqlite3",
      [dbFile],
      { timeout: TIMEOUT_MS, maxBuffer: 5 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          // Check if it's just a timeout
          if (err.killed) return reject(new Error("Query timed out (10s limit)"));
          // sqlite3 puts errors on stderr
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
  const { action, database = "default", format = "json" } = args;

  if (!action) {
    return fail("action is required", start);
  }

  await fs.mkdir(SANDBOX_DIR, { recursive: true });
  const db = dbPath(database);

  try {
    switch (action) {
      case "query": {
        const { sql } = args;
        if (!sql || typeof sql !== "string") throw new Error("sql is required for query");
        assertSafeSql(sql);

        let commands: string;
        if (format === "csv") {
          commands = `.mode csv\n.headers on\n${sql};\n`;
        } else if (format === "table") {
          commands = `.mode table\n.headers on\n${sql};\n`;
        } else {
          commands = `.mode json\n${sql};\n`;
        }

        const output = await runSqlite(db, commands);

        if (format === "json") {
          try {
            const rows = JSON.parse(output || "[]");
            const truncated = rows.length > MAX_ROWS;
            const data = truncated ? rows.slice(0, MAX_ROWS) : rows;
            return ok({ action: "query", data, rows: data.length, truncated, database }, start);
          } catch {
            // Fall through to raw output if JSON parse fails
            return ok({ action: "query", data: output.trim(), database }, start);
          }
        }
        return ok({ action: "query", data: output.trim(), database }, start);
      }

      case "execute": {
        const { sql } = args;
        if (!sql || typeof sql !== "string") throw new Error("sql is required for execute");
        assertSafeSql(sql);

        await runSqlite(db, `${sql};\n.print ROWS_CHANGED\nSELECT changes();\n`);
        return ok({ action: "execute", database, text: "Statement executed" }, start);
      }

      case "tables": {
        const output = await runSqlite(db, ".mode json\nSELECT name, type FROM sqlite_master WHERE type IN ('table','view') ORDER BY name;\n");
        const tables = JSON.parse(output || "[]");
        return ok({ action: "tables", database, data: tables }, start);
      }

      case "schema": {
        const output = await runSqlite(db, ".schema\n");
        return ok({ action: "schema", database, data: output.trim() }, start);
      }

      case "export": {
        const output = await runSqlite(db, ".dump\n");
        const exportPath = path.join(SANDBOX_DIR, `${database}_export.sql`);
        await fs.writeFile(exportPath, output, "utf8");
        return ok({ action: "export", database, path: `sandbox/${database}_export.sql`, bytes: Buffer.byteLength(output) }, start);
      }

      default:
        throw new Error(`Unknown action: ${action}. Use: query, execute, tables, schema, export`);
    }
  } catch (err: any) {
    return fail(err.message, start);
  }
}

function ok(fields: any, start: number): string {
  return JSON.stringify({ status: "ok", elapsedMs: Date.now() - start, ...fields });
}

function fail(error: string, start: number): string {
  return JSON.stringify({ status: "error", error, elapsedMs: Date.now() - start });
}
