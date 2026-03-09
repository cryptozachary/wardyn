import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

export const parameters = {
  "type": "object",
  "properties": {
    "Test URL": {
      "type": "string",
      "description": "URL of the image to download"
    }
  },
  "required": [
    "Test URL"
  ]
};

export async function execute(args: any): Promise<string> {
  // Resolve skill source dir (main.py lives in skills/, not dist/skills/)
  const skillName = path.basename(path.dirname(fileURLToPath(import.meta.url)));
  const dir = path.join(process.cwd(), "skills", skillName);
  const script = path.join(dir, "main.py");
  const pythonCmd = process.platform === "win32" ? "python" : "python3";
  return new Promise((resolve, reject) => {
    const proc = spawn(pythonCmd, [script], {
      cwd: dir, timeout: 30000,
      stdio: ["pipe", "pipe", "pipe"]
    });
    proc.stdin.write(JSON.stringify(args));
    proc.stdin.end();
    let stdout = "", stderr = "";
    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    proc.on("close", (code) => {
      if (code !== 0) reject(new Error(stderr || `Exit code ${code}`));
      else resolve(stdout.trim());
    });
    proc.on("error", reject);
  });
}
