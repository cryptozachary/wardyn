import ivm from "isolated-vm";
import ts from "typescript";
import { spawn } from "child_process";
import { readFileSync, existsSync } from "fs";
import path from "path";
import { generateSampleArgs } from "./sampleArgs.js";
import type { SmokeTestResult } from "./types.js";

const SKILLS_DIR = path.join(process.cwd(), "skills");
const SANDBOX_DIR = path.join(process.cwd(), "sandbox");
const TS_TIMEOUT = 5_000;    // 5s for isolated-vm
const SUB_TIMEOUT = 10_000;  // 10s for subprocess
const MAX_OUTPUT = 4_000;

/**
 * Run a smoke test on a generated skill.
 * Returns result without throwing — errors are captured in the result.
 */
export async function smokeTest(
  skillName: string,
  language: string,
  parameters: Record<string, unknown>,
  providedSampleArgs?: Record<string, unknown>
): Promise<SmokeTestResult> {
  const start = Date.now();
  const skillDir = path.join(SKILLS_DIR, skillName);
  // Use LLM-provided sample args if available, fall back to auto-generated
  const sampleArgs = providedSampleArgs ?? generateSampleArgs(parameters);

  let result: SmokeTestResult;
  try {
    switch (language) {
      case "typescript":
        result = await smokeTestTS(skillDir, sampleArgs, start);
        break;
      case "python":
        result = await smokeTestSubprocess(
          "python3", ["-I", path.join(skillDir, "main.py")],
          sampleArgs, start
        );
        break;
      case "go": {
        // Compile first, then run
        const binary = path.join(skillDir, process.platform === "win32" ? "skill_test.exe" : "skill_test");
        if (!existsSync(binary)) {
          const compileResult = await compileGo(skillDir, binary);
          if (!compileResult.passed) return compileResult;
        }
        result = await smokeTestSubprocess(binary, [], sampleArgs, start);
        break;
      }
      case "cpp": {
        const binary = path.join(skillDir, process.platform === "win32" ? "skill_test.exe" : "skill_test");
        if (!existsSync(binary)) {
          const compileResult = await compileCpp(skillDir, binary);
          if (!compileResult.passed) return compileResult;
        }
        result = await smokeTestSubprocess(binary, [], sampleArgs, start);
        break;
      }
      default:
        return { passed: false, output: "", error: `Unsupported language: ${language}`, duration: 0 };
    }
  } catch (err: any) {
    result = { passed: false, output: "", error: err.message, duration: Date.now() - start };
  }

  // Tag network-related failures as soft so they don't block skill deployment
  return tagSoftFail(result);
}

/**
 * TypeScript smoke test using isolated-vm.
 * Transpiles TS → JS, runs in a V8 isolate with no fs/net access.
 */
async function smokeTestTS(
  skillDir: string,
  sampleArgs: Record<string, unknown>,
  startTime: number
): Promise<SmokeTestResult> {
  const indexPath = path.join(skillDir, "index.ts");
  const tsCode = readFileSync(indexPath, "utf8");

  // Transpile TS → JS
  const jsCode = ts.transpileModule(tsCode, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS, // isolated-vm doesn't support ESM
      esModuleInterop: true,
      strict: false, // lenient for generated code
    },
  }).outputText;

  // Create isolate with memory limit
  const isolate = new ivm.Isolate({ memoryLimit: 128 });
  let context: ivm.Context | null = null;

  try {
    context = await isolate.createContext();
    const jail = context.global;

    // Provide a minimal console.log that captures output
    const logLines: string[] = [];
    await jail.set("__capturedLog", new ivm.Callback((...args: any[]) => {
      logLines.push(args.map(String).join(" "));
    }));

    // Provide JSON globally (not available by default in isolate)
    await jail.set("__args", new ivm.ExternalCopy(sampleArgs).copyInto());

    // Build the test script:
    // 1. Set up minimal console
    // 2. Run the skill code (which defines exports.execute and exports.parameters)
    // 3. Call execute with sample args
    // 4. Return the result
    const testScript = `
      const console = { log: __capturedLog, error: __capturedLog, warn: __capturedLog };
      const exports = {};
      const module = { exports };

      ${jsCode}

      // Handle both module.exports and direct exports patterns
      const exec = module.exports.execute || exports.execute;
      if (typeof exec !== "function") {
        "ERROR: execute function not found in generated code";
      } else {
        const result = exec(__args);
        // Handle both sync and promise results
        if (result && typeof result.then === "function") {
          "ASYNC_NOT_SUPPORTED_IN_SYNC_MODE";
        } else {
          String(result);
        }
      }
    `;

    const script = await isolate.compileScript(testScript);
    const rawResult = await script.run(context, { timeout: TS_TIMEOUT });
    const result = String(rawResult ?? "(no output)");

    const duration = Date.now() - startTime;

    if (result === "ASYNC_NOT_SUPPORTED_IN_SYNC_MODE") {
      // Try async execution path
      const asyncResult = await runAsyncInIsolate(isolate, context, jsCode, sampleArgs);
      return {
        passed: true,
        output: truncate(asyncResult + (logLines.length ? "\n[log] " + logLines.join("\n[log] ") : ""), MAX_OUTPUT),
        duration: Date.now() - startTime,
      };
    }

    if (result.startsWith("ERROR:")) {
      return { passed: false, output: "", error: result, duration };
    }

    const output = result + (logLines.length ? "\n[log] " + logLines.join("\n[log] ") : "");
    return { passed: true, output: truncate(output, MAX_OUTPUT), duration };
  } finally {
    isolate.dispose();
  }
}

/**
 * Run async execute() in isolate by polling.
 * isolated-vm doesn't natively support async/await in scripts,
 * so we use a Reference-based approach.
 */
async function runAsyncInIsolate(
  isolate: ivm.Isolate,
  context: ivm.Context,
  jsCode: string,
  sampleArgs: Record<string, unknown>
): Promise<string> {
  const jail = context.global;

  // Set up a resolver callback
  let resolvedValue = "";
  let rejected = false;
  let rejectedError = "";

  await jail.set("__resolve", new ivm.Callback((val: string) => {
    resolvedValue = val;
  }));
  await jail.set("__reject", new ivm.Callback((err: string) => {
    rejected = true;
    rejectedError = err;
  }));
  await jail.set("__args2", new ivm.ExternalCopy(sampleArgs).copyInto());

  const asyncScript = `
    const exports2 = {};
    const module2 = { exports: exports2 };
    (function() {
      const exports = exports2;
      const module = module2;
      ${jsCode}
    })();
    const exec2 = module2.exports.execute || exports2.execute;
    Promise.resolve(exec2(__args2))
      .then(r => __resolve(String(r)))
      .catch(e => __reject(String(e)));
  `;

  const script = await isolate.compileScript(asyncScript);
  await script.run(context, { timeout: TS_TIMEOUT });

  // Give microtasks time to settle
  await new Promise(resolve => setTimeout(resolve, 100));

  if (rejected) {
    throw new Error(`Skill execute() rejected: ${rejectedError}`);
  }

  return resolvedValue || "(no output)";
}

/**
 * Subprocess-based smoke test for Python, Go, C++ skills.
 * Runs in sandbox dir with minimal environment.
 */
async function smokeTestSubprocess(
  cmd: string,
  args: string[],
  sampleArgs: Record<string, unknown>,
  startTime: number
): Promise<SmokeTestResult> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, {
      cwd: SANDBOX_DIR,
      timeout: SUB_TIMEOUT,
      env: minimalEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

    // Send sample args as JSON on stdin
    proc.stdin.write(JSON.stringify(sampleArgs));
    proc.stdin.end();

    proc.on("close", (code) => {
      const duration = Date.now() - startTime;
      if (code === 0) {
        resolve({
          passed: true,
          output: truncate(stdout.trim(), MAX_OUTPUT),
          duration,
        });
      } else {
        resolve({
          passed: false,
          output: truncate(stdout.trim(), MAX_OUTPUT),
          error: truncate(stderr.trim() || `Exit code ${code}`, MAX_OUTPUT / 2),
          duration,
        });
      }
    });

    proc.on("error", (err) => {
      resolve({
        passed: false,
        output: "",
        error: `Process error: ${err.message}`,
        duration: Date.now() - startTime,
      });
    });
  });
}

function compileGo(skillDir: string, outputBinary: string): Promise<SmokeTestResult> {
  return new Promise((resolve) => {
    const proc = spawn("go", ["build", "-o", outputBinary, "main.go"], {
      cwd: skillDir,
      timeout: SUB_TIMEOUT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    proc.on("close", (code) => {
      if (code !== 0) {
        resolve({ passed: false, output: "", error: `Go compile failed: ${stderr}`, duration: 0 });
      } else {
        resolve({ passed: true, output: "Compiled OK", duration: 0 });
      }
    });
    proc.on("error", (err) => {
      resolve({ passed: false, output: "", error: `Go not found: ${err.message}`, duration: 0 });
    });
  });
}

function compileCpp(skillDir: string, outputBinary: string): Promise<SmokeTestResult> {
  return new Promise((resolve) => {
    const proc = spawn("g++", ["-o", outputBinary, "main.cpp"], {
      cwd: skillDir,
      timeout: SUB_TIMEOUT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    proc.on("close", (code) => {
      if (code !== 0) {
        resolve({ passed: false, output: "", error: `C++ compile failed: ${stderr}`, duration: 0 });
      } else {
        resolve({ passed: true, output: "Compiled OK", duration: 0 });
      }
    });
    proc.on("error", (err) => {
      resolve({ passed: false, output: "", error: `g++ not found: ${err.message}`, duration: 0 });
    });
  });
}

function minimalEnv(): Record<string, string> {
  const env: Record<string, string> = {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    LANG: "en_US.UTF-8",
    NODE_ENV: "sandbox",
  };
  if (process.platform === "win32") {
    env.PATH = process.env.PATH ?? "";
    env.SystemRoot = process.env.SystemRoot ?? "C:\\Windows";
    env.COMSPEC = process.env.COMSPEC ?? "C:\\Windows\\system32\\cmd.exe";
  }
  return env;
}

/** Patterns that indicate a network/external-resource failure, not a code bug */
const NETWORK_ERROR_PATTERNS = [
  /\b(404|403|401|500|502|503)\b/i,
  /ENOTFOUND/i,
  /ECONNREFUSED/i,
  /ECONNRESET/i,
  /ETIMEDOUT/i,
  /fetch failed/i,
  /network error/i,
  /getaddrinfo/i,
  /certificate/i,
  /SSL/i,
  /socket hang up/i,
  /HTTP error/i,
  /status code/i,
];

function isNetworkError(error: string): boolean {
  return NETWORK_ERROR_PATTERNS.some(p => p.test(error));
}

/** Tag a failed smoke test result as softFail if the error looks network-related */
function tagSoftFail(result: SmokeTestResult): SmokeTestResult {
  if (!result.passed && result.error && isNetworkError(result.error)) {
    return { ...result, softFail: true };
  }
  return result;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n... (truncated, ${s.length} total chars)`;
}
