/**
 * AST-level code analysis — supplements regex-based SafetySpine with
 * actual parsing to catch obfuscated dangerous patterns.
 *
 * For TypeScript/JavaScript: uses the TypeScript compiler API to walk the AST.
 * For Python: uses a subprocess call to Python's ast module.
 * For Go/C++: uses targeted regex (no native parser available in Node).
 */

import ts from "typescript";
import { spawn } from "child_process";
import { writeFileSync, unlinkSync, mkdirSync, existsSync } from "fs";
import path from "path";

const SANDBOX_DIR = path.join(process.cwd(), "sandbox");

export interface ASTWarning {
  type: string;
  severity: "block" | "warn" | "info";
  location?: string;
  description: string;
}

/* ───────── Dangerous Node.js / browser APIs ───────── */

const BLOCKED_IMPORTS: Record<string, string> = {
  child_process: "Spawns OS processes",
  cluster: "Spawns worker processes",
  dgram: "Raw UDP sockets",
  net: "Raw TCP sockets",
  tls: "Raw TLS sockets",
  vm: "Dynamic code execution",
  "worker_threads": "Spawns worker threads",
};

const WARN_IMPORTS: Record<string, string> = {
  fs: "Filesystem access",
  "fs/promises": "Filesystem access",
  http: "HTTP server/client",
  https: "HTTPS server/client",
  os: "OS information access",
  process: "Process manipulation",
};

const BLOCKED_GLOBALS = new Set([
  "eval",
  "Function",
  "execSync",
  "spawnSync",
  "exec",
  "spawn",
  "fork",
]);

const BLOCKED_MEMBER_ACCESS: Record<string, Set<string>> = {
  process: new Set(["exit", "kill", "abort", "env"]),
  require: new Set(["resolve"]), // dynamic require
};

/* ───────── TypeScript / JavaScript AST analysis ───────── */

export function analyzeTypeScript(code: string): ASTWarning[] {
  const warnings: ASTWarning[] = [];

  let sourceFile: ts.SourceFile;
  try {
    sourceFile = ts.createSourceFile("skill.ts", code, ts.ScriptTarget.ES2022, true);
  } catch {
    warnings.push({ type: "parse_error", severity: "warn", description: "Failed to parse TypeScript AST" });
    return warnings;
  }

  function visit(node: ts.Node): void {
    const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    const loc = `line ${pos.line + 1}`;

    // ── Import declarations ──
    if (ts.isImportDeclaration(node)) {
      const specifier = (node.moduleSpecifier as ts.StringLiteral).text;
      if (BLOCKED_IMPORTS[specifier]) {
        warnings.push({
          type: "blocked_import",
          severity: "block",
          location: loc,
          description: `Import "${specifier}" blocked: ${BLOCKED_IMPORTS[specifier]}`,
        });
      } else if (WARN_IMPORTS[specifier]) {
        warnings.push({
          type: "warn_import",
          severity: "warn",
          location: loc,
          description: `Import "${specifier}": ${WARN_IMPORTS[specifier]}`,
        });
      }
    }

    // ── require() calls ──
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require") {
      const arg = node.arguments[0];
      if (arg && ts.isStringLiteral(arg)) {
        if (BLOCKED_IMPORTS[arg.text]) {
          warnings.push({
            type: "blocked_require",
            severity: "block",
            location: loc,
            description: `require("${arg.text}") blocked: ${BLOCKED_IMPORTS[arg.text]}`,
          });
        } else if (WARN_IMPORTS[arg.text]) {
          warnings.push({
            type: "warn_require",
            severity: "warn",
            location: loc,
            description: `require("${arg.text}"): ${WARN_IMPORTS[arg.text]}`,
          });
        }
      } else {
        // Dynamic require — can't statically determine what it loads
        warnings.push({
          type: "dynamic_require",
          severity: "block",
          location: loc,
          description: "Dynamic require() with non-literal argument — potential code injection",
        });
      }
    }

    // ── eval() and Function() constructor ──
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const name = node.expression.text;
      if (name === "eval") {
        warnings.push({
          type: "eval",
          severity: "block",
          location: loc,
          description: "eval() call detected — arbitrary code execution",
        });
      }
      if (name === "Function") {
        warnings.push({
          type: "function_constructor",
          severity: "block",
          location: loc,
          description: "Function() constructor — dynamic code generation",
        });
      }
    }

    // ── new Function() ──
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Function") {
      warnings.push({
        type: "function_constructor",
        severity: "block",
        location: loc,
        description: "new Function() — dynamic code generation",
      });
    }

    // ── Property access on dangerous objects ──
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
      const obj = node.expression.text;
      const prop = node.name.text;

      if (BLOCKED_MEMBER_ACCESS[obj]?.has(prop)) {
        warnings.push({
          type: "blocked_member",
          severity: "warn",
          location: loc,
          description: `${obj}.${prop} access detected`,
        });
      }

      // child_process methods via imported variable
      if (BLOCKED_GLOBALS.has(prop) && (obj !== "exports" && obj !== "module")) {
        warnings.push({
          type: "blocked_global_access",
          severity: "warn",
          location: loc,
          description: `Access to potentially dangerous function: ${obj}.${prop}`,
        });
      }
    }

    // ── Template literal with expressions used in dangerous contexts ──
    if (ts.isTaggedTemplateExpression(node) && ts.isIdentifier(node.tag) && node.tag.text === "eval") {
      warnings.push({
        type: "eval_template",
        severity: "block",
        location: loc,
        description: "eval used as template tag — code injection risk",
      });
    }

    // ── globalThis / window access to bypass restrictions ──
    if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression)) {
      const obj = node.expression.text;
      if (obj === "globalThis" || obj === "global" || obj === "window") {
        warnings.push({
          type: "global_bracket_access",
          severity: "warn",
          location: loc,
          description: `${obj}[...] bracket access — may bypass static analysis`,
        });
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return warnings;
}

/* ───────── Python AST analysis ───────── */

const PYTHON_ANALYZER_CODE = `
import ast, sys, json

BLOCKED_MODULES = {
    "os": "OS command execution",
    "subprocess": "Process spawning",
    "shutil": "File operations",
    "importlib": "Dynamic imports",
    "ctypes": "C library access",
    "socket": "Raw socket access",
    "multiprocessing": "Process spawning",
    "signal": "Signal handling",
    "pty": "Pseudo-terminal",
    "commands": "OS commands (legacy)",
}

BLOCKED_FUNCTIONS = {
    "eval": "Arbitrary code execution",
    "exec": "Arbitrary code execution",
    "compile": "Code compilation",
    "__import__": "Dynamic import",
    "getattr": "Dynamic attribute access",
    "setattr": "Dynamic attribute setting",
    "delattr": "Dynamic attribute deletion",
    "globals": "Global scope access",
    "locals": "Local scope access",
}

WARN_MODULES = {
    "http": "HTTP access",
    "urllib": "URL access",
    "requests": "HTTP requests",
    "pathlib": "Path manipulation",
    "tempfile": "Temp file creation",
    "io": "I/O operations",
}

warnings = []

try:
    tree = ast.parse(sys.stdin.read())
except SyntaxError as e:
    warnings.append({"type": "parse_error", "severity": "warn", "description": f"Python syntax error: {e}"})
    print(json.dumps(warnings))
    sys.exit(0)

for node in ast.walk(tree):
    loc = f"line {getattr(node, 'lineno', '?')}"

    # Import checks
    if isinstance(node, ast.Import):
        for alias in node.names:
            mod = alias.name.split(".")[0]
            if mod in BLOCKED_MODULES:
                warnings.append({"type": "blocked_import", "severity": "block", "location": loc,
                                  "description": f"import {alias.name} blocked: {BLOCKED_MODULES[mod]}"})
            elif mod in WARN_MODULES:
                warnings.append({"type": "warn_import", "severity": "warn", "location": loc,
                                  "description": f"import {alias.name}: {WARN_MODULES[mod]}"})

    elif isinstance(node, ast.ImportFrom):
        mod = (node.module or "").split(".")[0]
        if mod in BLOCKED_MODULES:
            warnings.append({"type": "blocked_import", "severity": "block", "location": loc,
                              "description": f"from {node.module} import ... blocked: {BLOCKED_MODULES[mod]}"})
        elif mod in WARN_MODULES:
            warnings.append({"type": "warn_import", "severity": "warn", "location": loc,
                              "description": f"from {node.module} import ...: {WARN_MODULES[mod]}"})

    # Function call checks
    elif isinstance(node, ast.Call):
        func_name = None
        if isinstance(node.func, ast.Name):
            func_name = node.func.id
        elif isinstance(node.func, ast.Attribute):
            func_name = node.func.attr

        if func_name and func_name in BLOCKED_FUNCTIONS:
            warnings.append({"type": "blocked_call", "severity": "block", "location": loc,
                              "description": f"{func_name}() blocked: {BLOCKED_FUNCTIONS[func_name]}"})

        # os.system, os.popen, subprocess.call, etc.
        if isinstance(node.func, ast.Attribute):
            if isinstance(node.func.value, ast.Name):
                obj = node.func.value.id
                method = node.func.attr
                if obj == "os" and method in ("system", "popen", "execvp", "execve", "execl"):
                    warnings.append({"type": "os_exec", "severity": "block", "location": loc,
                                      "description": f"os.{method}() — direct OS command execution"})
                if obj == "subprocess" and method in ("call", "run", "Popen", "check_output", "check_call"):
                    warnings.append({"type": "subprocess", "severity": "block", "location": loc,
                                      "description": f"subprocess.{method}() — process spawning"})

    # open() with write mode
    elif isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "open":
        if len(node.args) >= 2:
            mode_arg = node.args[1]
            if isinstance(mode_arg, ast.Constant) and isinstance(mode_arg.value, str):
                if any(c in mode_arg.value for c in ("w", "a", "x")):
                    warnings.append({"type": "file_write", "severity": "warn", "location": loc,
                                      "description": f"open() with write mode '{mode_arg.value}'"})

print(json.dumps(warnings))
`;

export async function analyzePython(code: string): Promise<ASTWarning[]> {
  if (!existsSync(SANDBOX_DIR)) mkdirSync(SANDBOX_DIR, { recursive: true });
  const tmpScript = path.join(SANDBOX_DIR, `_ast_analyze_${Date.now()}.py`);
  writeFileSync(tmpScript, PYTHON_ANALYZER_CODE, "utf8");

  return new Promise((resolve) => {
    const pythonCmd = process.platform === "win32" ? "python" : "python3";
    const proc = spawn(pythonCmd, [tmpScript], {
      cwd: SANDBOX_DIR,
      timeout: 10_000,
      stdio: ["pipe", "pipe", "pipe"],
    });

    proc.stdin.write(code);
    proc.stdin.end();

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

    proc.on("close", () => {
      try { unlinkSync(tmpScript); } catch {}
      try {
        resolve(JSON.parse(stdout));
      } catch {
        resolve([{ type: "analyzer_error", severity: "warn", description: `Python AST analyzer failed: ${stderr || "unknown"}` }]);
      }
    });

    proc.on("error", () => {
      try { unlinkSync(tmpScript); } catch {}
      resolve([{ type: "analyzer_error", severity: "info", description: "Python not available for AST analysis" }]);
    });
  });
}

/* ───────── Go analysis (targeted regex — no native parser) ───────── */

export function analyzeGo(code: string): ASTWarning[] {
  const warnings: ASTWarning[] = [];
  const lines = code.split("\n");

  const BLOCKED_GO_IMPORTS = [
    { pattern: /\"os\/exec\"/, desc: "os/exec — command execution" },
    { pattern: /\"syscall\"/, desc: "syscall — direct system calls" },
    { pattern: /\"unsafe\"/, desc: "unsafe — memory manipulation" },
    { pattern: /\"plugin\"/, desc: "plugin — dynamic code loading" },
    { pattern: /\"debug\//, desc: "debug — debugger access" },
  ];

  const WARN_GO_IMPORTS = [
    { pattern: /\"os\"/, desc: "os — OS operations" },
    { pattern: /\"net\"/, desc: "net — network access" },
    { pattern: /\"net\/http\"/, desc: "net/http — HTTP access" },
    { pattern: /\"io\/ioutil\"/, desc: "io/ioutil — file I/O" },
  ];

  const BLOCKED_GO_CALLS = [
    { pattern: /exec\.Command\(/, desc: "exec.Command() — process spawning" },
    { pattern: /syscall\.(Exec|ForkExec)\(/, desc: "syscall.Exec/ForkExec — direct process exec" },
    { pattern: /os\.(Remove|RemoveAll|Rename)\(/, desc: "Destructive filesystem operation" },
  ];

  lines.forEach((line, i) => {
    const loc = `line ${i + 1}`;
    for (const imp of BLOCKED_GO_IMPORTS) {
      if (imp.pattern.test(line)) {
        warnings.push({ type: "blocked_import", severity: "block", location: loc, description: `Import ${imp.desc}` });
      }
    }
    for (const imp of WARN_GO_IMPORTS) {
      if (imp.pattern.test(line)) {
        warnings.push({ type: "warn_import", severity: "warn", location: loc, description: `Import ${imp.desc}` });
      }
    }
    for (const call of BLOCKED_GO_CALLS) {
      if (call.pattern.test(line)) {
        warnings.push({ type: "blocked_call", severity: "block", location: loc, description: call.desc });
      }
    }
  });

  return warnings;
}

/* ───────── C++ analysis (targeted regex) ───────── */

export function analyzeCpp(code: string): ASTWarning[] {
  const warnings: ASTWarning[] = [];
  const lines = code.split("\n");

  const BLOCKED_CPP = [
    { pattern: /\bsystem\s*\(/, desc: "system() — shell command execution" },
    { pattern: /\bexec[lv]p?\s*\(/, desc: "exec*() — process replacement" },
    { pattern: /\bfork\s*\(/, desc: "fork() — process creation" },
    { pattern: /\bpopen\s*\(/, desc: "popen() — pipe to shell" },
    { pattern: /\bdlopen\s*\(/, desc: "dlopen() — dynamic library loading" },
    { pattern: /\bdlsym\s*\(/, desc: "dlsym() — dynamic symbol resolution" },
    { pattern: /\bunlink\s*\(/, desc: "unlink() — file deletion" },
    { pattern: /\bremove\s*\(/, desc: "remove() — file deletion" },
    { pattern: /#include\s*<(dlfcn|signal|sys\/ptrace)\.h>/, desc: "Dangerous system header" },
  ];

  const WARN_CPP = [
    { pattern: /#include\s*<fstream>/, desc: "File I/O operations" },
    { pattern: /#include\s*<(sys\/socket|netinet|arpa)/, desc: "Network socket access" },
    { pattern: /\bmalloc\s*\(|\bcalloc\s*\(|\brealloc\s*\(/, desc: "Manual memory allocation" },
  ];

  lines.forEach((line, i) => {
    const loc = `line ${i + 1}`;
    for (const p of BLOCKED_CPP) {
      if (p.pattern.test(line)) {
        warnings.push({ type: "blocked_call", severity: "block", location: loc, description: p.desc });
      }
    }
    for (const p of WARN_CPP) {
      if (p.pattern.test(line)) {
        warnings.push({ type: "warn_pattern", severity: "warn", location: loc, description: p.desc });
      }
    }
  });

  return warnings;
}

/* ───────── Unified entry point ───────── */

export async function analyzeCode(code: string, language: string): Promise<ASTWarning[]> {
  switch (language) {
    case "typescript":
    case "javascript":
      return analyzeTypeScript(code);
    case "python":
      return analyzePython(code);
    case "go":
      return analyzeGo(code);
    case "cpp":
      return analyzeCpp(code);
    default:
      return [];
  }
}

/**
 * Check if any warnings are blocking severity.
 * Returns { safe: true } or { safe: false, reasons: [...] }
 */
export async function assertCodeSafe(code: string, language: string): Promise<{ safe: boolean; warnings: ASTWarning[]; blockers: ASTWarning[] }> {
  const warnings = await analyzeCode(code, language);
  const blockers = warnings.filter(w => w.severity === "block");
  return { safe: blockers.length === 0, warnings, blockers };
}
