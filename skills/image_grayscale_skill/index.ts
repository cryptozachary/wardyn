import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

export const parameters = {
  "type": "object",
  "properties": {
    "Test URL": {
      "type": "string",
      "description": "The URL of the image to download and process."
    }
  },
  "required": [
    "Test URL"
  ]
};

export async function execute(args: any): Promise<string> {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const script = path.join(dir, "main.py");
  return new Promise((resolve, reject) => {
    const proc = spawn("python3", [script], {
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
