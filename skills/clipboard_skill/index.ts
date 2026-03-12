import { execFile, exec } from "child_process";
import { platform } from "os";

export const parameters = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["read", "write"],
      description: "Clipboard action: read (get clipboard contents) or write (set clipboard contents)",
    },
    text: { type: "string", description: "Text to write to clipboard (required for write)" },
  },
  required: ["action"],
};

/* ────────────────────── constants ────────────────────── */

const MAX_SIZE = 100_000; // 100KB clipboard limit
const TIMEOUT = 5000;

/* ────────────────────── platform commands ────────────────────── */

function getReadCmd(): { cmd: string; args: string[] } {
  const os = platform();
  if (os === "win32") return { cmd: "powershell", args: ["-NoProfile", "-Command", "Get-Clipboard"] };
  if (os === "darwin") return { cmd: "pbpaste", args: [] };
  // Linux — try xclip, fall back to xsel
  return { cmd: "xclip", args: ["-selection", "clipboard", "-o"] };
}

function getWriteCmd(): { cmd: string; shellPipe: boolean } {
  const os = platform();
  if (os === "win32") return { cmd: "clip", shellPipe: true };
  if (os === "darwin") return { cmd: "pbcopy", shellPipe: true };
  return { cmd: "xclip -selection clipboard", shellPipe: true };
}

/* ────────────────────── execute ────────────────────── */

export async function execute(args: any): Promise<string> {
  const start = Date.now();
  const { action } = args;

  try {
    switch (action) {
      case "read": {
        const { cmd, args: cmdArgs } = getReadCmd();
        const text = await runRead(cmd, cmdArgs);
        const truncated = text.length > MAX_SIZE;
        return JSON.stringify({
          status: "ok",
          action: "read",
          text: truncated ? text.slice(0, MAX_SIZE) : text,
          chars: text.length,
          truncated,
          elapsedMs: Date.now() - start,
        });
      }

      case "write": {
        const { text } = args;
        if (typeof text !== "string") throw new Error("text is required for write");
        if (text.length > MAX_SIZE) throw new Error(`Text too large (${text.length} chars, max ${MAX_SIZE})`);
        await runWrite(text);
        return JSON.stringify({
          status: "ok",
          action: "write",
          chars: text.length,
          elapsedMs: Date.now() - start,
        });
      }

      default:
        throw new Error(`Unknown action: ${action}. Use: read, write`);
    }
  } catch (err: any) {
    return JSON.stringify({ status: "error", action, error: err.message, elapsedMs: Date.now() - start });
  }
}

/* ────────────────────── helpers ────────────────────── */

function runRead(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: TIMEOUT, maxBuffer: MAX_SIZE + 1024 }, (err, stdout) => {
      if (err) return reject(new Error(`Clipboard read failed: ${err.message}`));
      resolve(stdout);
    });
  });
}

function runWrite(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const os = platform();
    let cmd: string;

    if (os === "win32") {
      cmd = "powershell -NoProfile -Command \"$input | Set-Clipboard\"";
    } else if (os === "darwin") {
      cmd = "pbcopy";
    } else {
      cmd = "xclip -selection clipboard";
    }

    const proc = exec(cmd, { timeout: TIMEOUT }, (err) => {
      if (err) return reject(new Error(`Clipboard write failed: ${err.message}`));
      resolve();
    });
    proc.stdin?.write(text);
    proc.stdin?.end();
  });
}
