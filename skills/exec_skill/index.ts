import { spawn } from "child_process";
import path from "path";
import { mkdirSync, existsSync, writeFileSync, unlinkSync } from "fs";
import { assertSafe } from "../../src/security/safetySpine.js";
import { analyzeTypeScript } from "../../src/security/astAnalyzer.js";

const SANDBOX_DIR = path.join(process.cwd(), "sandbox");
const TIMEOUT_MS = 15_000;
const MAX_OUTPUT = 4000; // characters

// Only these interpreters are allowed
const ALLOWED_INTERPRETERS: Record<string, string[]> = {
  bash:   ["bash", "-c"],
  sh:     ["sh", "-c"],
  node:   ["node", "-e"],
  python: ["python", "-c"],
  python3:["python3", "-c"],
};

export const parameters = {
  type: "object",
  properties: {
    command: {
      type: "string",
      description: "The command or code to execute. Runs inside the sandbox directory."
    },
    interpreter: {
      type: "string",
      enum: ["bash", "sh", "node", "python", "python3"],
      description: "Which interpreter to use (default: bash)"
    },
    timeout: {
      type: "number",
      description: "Timeout in milliseconds (default: 15000, max: 30000)"
    }
  },
  required: ["command"]
};

export async function execute(args: any): Promise<string> {
  const { command, interpreter = "bash", timeout } = args;

  if (typeof command !== "string" || command.trim().length === 0) {
    throw new Error("command is required and must be a non-empty string");
  }

  // Validate interpreter
  const interp = ALLOWED_INTERPRETERS[interpreter];
  if (!interp) {
    throw new Error(`Interpreter "${interpreter}" not allowed. Use: ${Object.keys(ALLOWED_INTERPRETERS).join(", ")}`);
  }

  // SafetySpine regex validation (also done by agentLoop, but double-check here)
  assertSafe(command);

  // Additional exec-specific blocks
  validateExecCommand(command, interpreter);

  // AST-level analysis for Node.js code — catches obfuscated dangerous patterns
  if (interpreter === "node") {
    const astWarnings = analyzeTypeScript(command);
    const blockers = astWarnings.filter(w => w.severity === "block");
    if (blockers.length > 0) {
      const reasons = blockers.map(b => `${b.location ?? ""}: ${b.description}`).join("; ");
      throw new Error(`AST analysis blocked execution: ${reasons}`);
    }
  }

  // Ensure sandbox exists
  if (!existsSync(SANDBOX_DIR)) {
    mkdirSync(SANDBOX_DIR, { recursive: true });
  }

  const effectiveTimeout = Math.min(timeout ?? TIMEOUT_MS, 30_000);

  // For node/python, write code to a temp file to avoid shell injection
  if (interpreter === "node" || interpreter === "python" || interpreter === "python3") {
    return runCode(interp[0], command, effectiveTimeout, interpreter);
  }

  return runShell(interp, command, effectiveTimeout);
}

function validateExecCommand(command: string, interpreter: string) {
  // Block path traversal attempts
  if (/\.\.[\/\\]/.test(command)) {
    throw new Error("Path traversal (..) is not allowed");
  }

  // Block attempts to change directory outside sandbox
  if (/\bcd\s+[\/~]/.test(command)) {
    throw new Error("Cannot change directory outside sandbox");
  }

  // Block network tools in shell mode
  if ((interpreter === "bash" || interpreter === "sh") &&
      /\b(wget|curl|nc|ncat|socat|telnet|ftp)\b/i.test(command)) {
    throw new Error("Network tools are not allowed in shell execution");
  }

  // Block fork bombs
  if (/:\(\)\{.*\|.*&\s*\};/.test(command) || /\bfork\b.*\bwhile\b.*\btrue\b/i.test(command)) {
    throw new Error("Potentially dangerous pattern detected");
  }
}

function runCode(interpreter: string, code: string, timeout: number, interpName: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const ext = interpName === "node" ? ".js" : ".py";
    const tmpFile = path.join(SANDBOX_DIR, `_exec_tmp_${Date.now()}${ext}`);
    writeFileSync(tmpFile, code, "utf8");

    // For Python, use -I (isolated) and -S (no site) flags for extra safety
    const args = interpName === "node"
      ? [tmpFile]
      : ["-I", "-S", tmpFile];

    const proc = spawn(interpreter, args, {
      cwd: SANDBOX_DIR,
      timeout,
      env: { ...minimalEnv(), HOME: SANDBOX_DIR, TMPDIR: SANDBOX_DIR },
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

    proc.on("close", (exitCode) => {
      try { unlinkSync(tmpFile); } catch {}
      resolve(formatOutput(stdout, stderr, exitCode));
    });

    proc.on("error", (err) => {
      try { unlinkSync(tmpFile); } catch {}
      reject(new Error(`Execution error: ${err.message}`));
    });
  });
}

function runShell(interp: string[], command: string, timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    if (process.platform === "win32" && (interp[0] === "bash" || interp[0] === "sh")) {
      reject(new Error(`POSIX shells (${interp[0]}) are not available on Windows. Use interpreter "node", "python", or "python3" instead.`));
      return;
    }
    const proc = spawn(interp[0], [...interp.slice(1), command], {
      cwd: SANDBOX_DIR,
      timeout,
      env: { ...minimalEnv(), HOME: SANDBOX_DIR, TMPDIR: SANDBOX_DIR },
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

    proc.on("close", (code) => {
      const out = formatOutput(stdout, stderr, code);
      resolve(out);
    });

    proc.on("error", (err) => {
      reject(new Error(`Execution error: ${err.message}`));
    });
  });
}

function formatOutput(stdout: string, stderr: string, exitCode: number | null): string {
  const parts: string[] = [];

  if (exitCode !== null && exitCode !== 0) {
    parts.push(`[exit code: ${exitCode}]`);
  }

  if (stdout.trim()) {
    parts.push(truncate(stdout.trim(), MAX_OUTPUT));
  }

  if (stderr.trim()) {
    parts.push(`[stderr]\n${truncate(stderr.trim(), MAX_OUTPUT / 2)}`);
  }

  if (parts.length === 0) {
    return "(no output)";
  }

  return parts.join("\n");
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n... (truncated, ${s.length} total chars)`;
}

function minimalEnv(): Record<string, string> {
  // Minimal safe environment - no PATH leaking, no credentials
  const env: Record<string, string> = {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    LANG: "en_US.UTF-8",
    NODE_ENV: "sandbox",
  };
  // On Windows, include basic system paths
  if (process.platform === "win32") {
    env.PATH = process.env.PATH ?? "";
    env.SystemRoot = process.env.SystemRoot ?? "C:\\Windows";
    env.COMSPEC = process.env.COMSPEC ?? "C:\\Windows\\system32\\cmd.exe";
  }
  return env;
}
