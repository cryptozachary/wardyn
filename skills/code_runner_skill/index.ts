import { execFile } from "child_process";
import { promises as fs } from "fs";
import path from "path";
import crypto from "crypto";

export const parameters = {
  type: "object",
  properties: {
    language: {
      type: "string",
      enum: ["javascript", "python"],
      description: "Language to run (javascript or python)",
    },
    code: { type: "string", description: "Code to execute. Use console.log (JS) or print() (Python) for output." },
    timeout: { type: "number", description: "Execution timeout in ms (default: 10000, max: 30000)" },
  },
  required: ["language", "code"],
};

/* ────────────────────── constants ────────────────────── */

const SANDBOX_DIR = path.join(process.cwd(), "sandbox");
const DEFAULT_TIMEOUT = 10000;
const MAX_TIMEOUT = 30000;
const MAX_OUTPUT = 10000; // chars

// Blocked patterns — prevent system access from code snippets
const BLOCKED_JS = [
  /require\s*\(\s*['"]child_process['"]\s*\)/,
  /require\s*\(\s*['"]fs['"]\s*\)/,
  /require\s*\(\s*['"]net['"]\s*\)/,
  /require\s*\(\s*['"]http['"]\s*\)/,
  /require\s*\(\s*['"]https['"]\s*\)/,
  /process\.exit/,
  /process\.env/,
  /process\.kill/,
  /execSync|spawnSync|exec\s*\(/,
];

const BLOCKED_PY = [
  /import\s+os\b/,
  /import\s+subprocess/,
  /import\s+shutil/,
  /import\s+socket/,
  /from\s+os\s+import/,
  /from\s+subprocess\s+import/,
  /__import__/,
  /os\.system/,
  /os\.popen/,
  /eval\s*\(/,
  /exec\s*\(/,
  /open\s*\([^)]*['"]\/(?!tmp)/,
];

/* ────────────────────── safety check ────────────────────── */

function assertSafeCode(code: string, language: string): void {
  const patterns = language === "javascript" ? BLOCKED_JS : BLOCKED_PY;
  for (const p of patterns) {
    if (p.test(code)) {
      throw new Error(`Blocked: code contains restricted pattern (${p.source}). Use dedicated skills for file/network/system access.`);
    }
  }
}

/* ────────────────────── execute ────────────────────── */

export async function execute(args: any): Promise<string> {
  const start = Date.now();
  const { language, code, timeout = DEFAULT_TIMEOUT } = args;

  if (!language || !code) {
    return JSON.stringify({ status: "error", error: "language and code are required", elapsedMs: 0 });
  }

  const effectiveTimeout = Math.min(Number(timeout) || DEFAULT_TIMEOUT, MAX_TIMEOUT);

  try {
    assertSafeCode(code, language);

    await fs.mkdir(SANDBOX_DIR, { recursive: true });
    const id = crypto.randomBytes(6).toString("hex");

    let cmd: string;
    let cmdArgs: string[];
    let tmpFile: string;

    if (language === "javascript") {
      tmpFile = path.join(SANDBOX_DIR, `_run_${id}.mjs`);
      await fs.writeFile(tmpFile, code, "utf8");
      cmd = process.execPath; // node
      cmdArgs = ["--no-warnings", tmpFile];
    } else {
      tmpFile = path.join(SANDBOX_DIR, `_run_${id}.py`);
      await fs.writeFile(tmpFile, code, "utf8");
      cmd = "python3";
      cmdArgs = [tmpFile];
    }

    try {
      const output = await runProcess(cmd, cmdArgs, effectiveTimeout);
      return JSON.stringify({
        status: "ok",
        language,
        output: output.slice(0, MAX_OUTPUT),
        truncated: output.length > MAX_OUTPUT,
        elapsedMs: Date.now() - start,
      });
    } finally {
      // Clean up temp file
      await fs.unlink(tmpFile).catch(() => {});
    }
  } catch (err: any) {
    return JSON.stringify({ status: "error", language, error: err.message, elapsedMs: Date.now() - start });
  }
}

function runProcess(cmd: string, args: string[], timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, {
      timeout,
      maxBuffer: 2 * 1024 * 1024,
      cwd: path.join(process.cwd(), "sandbox"),
    }, (err, stdout, stderr) => {
      if (err) {
        if (err.killed) return reject(new Error(`Execution timed out (${timeout}ms limit)`));
        const errOutput = stderr?.trim() || err.message;
        return reject(new Error(errOutput));
      }
      const combined = stdout + (stderr ? `\n[stderr] ${stderr}` : "");
      resolve(combined.trim());
    });
  });
}
