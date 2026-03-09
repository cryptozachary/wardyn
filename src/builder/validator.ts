import { spawn } from "child_process";
import path from "path";
import type { ValidationResult } from "./types.js";

const SKILLS_DIR = path.join(process.cwd(), "skills");
const TIMEOUT_MS = 30_000;

export async function validate(skillName: string, language: string): Promise<ValidationResult> {
  const skillDir = path.join(SKILLS_DIR, skillName);

  switch (language) {
    case "typescript":
      return validateTypeScript(skillDir);
    case "python":
      return validatePython(path.join(skillDir, "main.py"));
    case "go":
      return validateGo(path.join(skillDir, "main.go"));
    case "cpp":
      return validateCpp(path.join(skillDir, "main.cpp"));
    default:
      return { valid: false, output: `Unknown language: ${language}` };
  }
}

function validateTypeScript(skillDir: string): Promise<ValidationResult> {
  const indexPath = path.join(skillDir, "index.ts");
  return runCommand("npx", [
    "tsc", "--noEmit", "--esModuleInterop",
    "--module", "nodenext", "--moduleResolution", "nodenext",
    "--target", "ES2022", "--skipLibCheck",
    indexPath,
  ]);
}

function validatePython(filePath: string): Promise<ValidationResult> {
  return runCommand("python3", [
    "-c",
    `import ast; ast.parse(open(r'${filePath}').read()); print('Syntax OK')`,
  ]);
}

function validateGo(filePath: string): Promise<ValidationResult> {
  const nullDev = process.platform === "win32" ? "NUL" : "/dev/null";
  return runCommand("go", ["build", "-o", nullDev, filePath]);
}

function validateCpp(filePath: string): Promise<ValidationResult> {
  return runCommand("g++", ["-fsyntax-only", filePath]);
}

function runCommand(cmd: string, args: string[]): Promise<ValidationResult> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, {
      cwd: process.cwd(),
      timeout: TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

    proc.on("close", (code) => {
      const output = (stdout + "\n" + stderr).trim();
      resolve({ valid: code === 0, output: output || (code === 0 ? "Validation passed" : `Exit code ${code}`) });
    });

    proc.on("error", (err) => {
      resolve({ valid: false, output: `Command not found or failed: ${err.message}. Is ${cmd} installed?` });
    });
  });
}
