import { promises as fs, constants } from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";

/* ────────────────────── parameters ────────────────────── */

const ALL_ACTIONS = [
  "read", "write", "append", "list", "exists", "stat",
  "mkdir", "delete", "rename", "copy",
] as const;

export const parameters = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: [...ALL_ACTIONS],
      description: "File operation to perform",
    },
    filePath: {
      type: "string",
      description: "Relative path inside sandbox (e.g. 'notes/todo.txt')",
      maxLength: 500,
    },
    destPath: {
      type: "string",
      description: "Destination path for rename/copy (relative to sandbox)",
      maxLength: 500,
    },
    data: {
      type: "string",
      description: "Content to write/append",
    },
    offset: {
      type: "number",
      description: "Start line (1-based) for partial read (default: 1)",
    },
    limit: {
      type: "number",
      description: "Max lines to read (default: all, max: 5000)",
    },
    encoding: {
      type: "string",
      enum: ["utf8", "base64"],
      description: "Encoding for read/write (default: utf8)",
    },
  },
  required: ["action", "filePath"],
};

/* ────────────────────── constants ────────────────────── */

const SANDBOX_DIR = path.join(process.cwd(), "sandbox");
const MAX_READ_BYTES = 2 * 1024 * 1024;   // 2 MB
const MAX_WRITE_BYTES = 5 * 1024 * 1024;  // 5 MB
const MAX_READ_LINES = 5000;

/* ────────────────────── path security ────────────────────── */

/**
 * Resolve a user-supplied relative path to a canonical absolute path
 * and verify it stays within the sandbox boundary.
 * Uses realpath for existing paths (catches symlink escapes)
 * and resolve for new paths (catches ../ traversal).
 */
async function safePath(relPath: string): Promise<string> {
  if (!relPath || typeof relPath !== "string") {
    throw new Error("filePath is required");
  }

  // Block absolute paths early
  if (path.isAbsolute(relPath)) {
    throw new Error("Absolute paths are not allowed — use relative paths inside sandbox");
  }

  // Resolve to absolute (this normalizes ../ etc.)
  const resolved = path.resolve(SANDBOX_DIR, relPath);

  // Boundary check on the resolved path (before realpath, in case file doesn't exist yet)
  const normalSandbox = path.resolve(SANDBOX_DIR) + path.sep;
  if (!resolved.startsWith(normalSandbox) && resolved !== path.resolve(SANDBOX_DIR)) {
    throw new Error("Path escapes sandbox boundary");
  }

  // For existing files, also check realpath to catch symlink escapes
  try {
    await fs.access(resolved, constants.F_OK);
    const real = await fs.realpath(resolved);
    if (!real.startsWith(normalSandbox) && real !== path.resolve(SANDBOX_DIR)) {
      throw new Error("Path escapes sandbox boundary (symlink detected)");
    }
    return real;
  } catch (err: any) {
    // File doesn't exist — that's fine for write/mkdir/etc, use resolved path
    if (err.code === "ENOENT") return resolved;
    // Re-throw our own boundary errors
    if (err.message?.includes("sandbox boundary")) throw err;
    return resolved;
  }
}

/* ────────────────────── structured response ────────────────────── */

interface FsResult {
  status: "ok" | "error";
  action: string;
  path?: string;
  bytes?: number;
  lines?: number;
  mtime?: string;
  data?: any;
  error?: string;
}

function ok(action: string, fields: Partial<FsResult>): string {
  return JSON.stringify({ status: "ok", action, ...fields });
}

function fail(action: string, error: string): string {
  return JSON.stringify({ status: "error", action, error });
}

/* ────────────────────── atomic write helper ────────────────────── */

async function atomicWrite(filePath: string, content: string | Buffer, encoding: BufferEncoding): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmpPath = path.join(dir, `.tmp_${crypto.randomBytes(8).toString("hex")}`);
  try {
    await fs.writeFile(tmpPath, content, encoding);
    await fs.rename(tmpPath, filePath);
  } catch (err) {
    // Clean up temp file on failure
    await fs.unlink(tmpPath).catch(() => {});
    throw err;
  }
}

/* ────────────────────── execute ────────────────────── */

export async function execute(args: any): Promise<string> {
  const { action } = args;
  if (!action || typeof action !== "string") {
    return fail("unknown", "action is required");
  }

  try {
    return await doAction(action, args);
  } catch (err: any) {
    return fail(action, err.message);
  }
}

async function doAction(action: string, args: any): Promise<string> {
  const encoding: BufferEncoding = args.encoding === "base64" ? "base64" : "utf8";

  switch (action) {
    /* ── read ── */
    case "read": {
      const full = await safePath(args.filePath);
      const stat = await fs.stat(full);

      if (!stat.isFile()) throw new Error("Not a file");
      if (stat.size > MAX_READ_BYTES) {
        throw new Error(`File too large (${stat.size} bytes, max ${MAX_READ_BYTES}). Use offset/limit for partial reads.`);
      }

      const raw = await fs.readFile(full, encoding);

      // Line-range support for utf8
      if (encoding === "utf8" && (args.offset || args.limit)) {
        const lines = raw.split("\n");
        const start = Math.max((args.offset ?? 1) - 1, 0);
        const count = Math.min(args.limit ?? MAX_READ_LINES, MAX_READ_LINES);
        const slice = lines.slice(start, start + count);
        return ok("read", {
          path: args.filePath,
          bytes: stat.size,
          lines: slice.length,
          data: slice.join("\n"),
        });
      }

      return ok("read", {
        path: args.filePath,
        bytes: stat.size,
        lines: encoding === "utf8" ? raw.split("\n").length : undefined,
        data: raw,
      });
    }

    /* ── write ── */
    case "write": {
      const data = args.data ?? "";
      const byteLen = Buffer.byteLength(data, encoding);
      if (byteLen > MAX_WRITE_BYTES) {
        throw new Error(`Content too large (${byteLen} bytes, max ${MAX_WRITE_BYTES})`);
      }
      const full = await safePath(args.filePath);
      await atomicWrite(full, data, encoding);
      return ok("write", { path: args.filePath, bytes: byteLen });
    }

    /* ── append ── */
    case "append": {
      const data = args.data ?? "";
      const byteLen = Buffer.byteLength(data, encoding);
      if (byteLen > MAX_WRITE_BYTES) {
        throw new Error(`Content too large (${byteLen} bytes, max ${MAX_WRITE_BYTES})`);
      }
      const full = await safePath(args.filePath);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.appendFile(full, data, encoding);
      const stat = await fs.stat(full);
      return ok("append", { path: args.filePath, bytes: stat.size });
    }

    /* ── list ── */
    case "list": {
      const full = await safePath(args.filePath);
      const stat = await fs.stat(full);
      if (!stat.isDirectory()) throw new Error("Not a directory");
      const entries = await fs.readdir(full, { withFileTypes: true });
      const items = entries.map((e) => ({
        name: e.name,
        type: e.isDirectory() ? "dir" : e.isFile() ? "file" : "other",
      }));
      return ok("list", { path: args.filePath, data: items });
    }

    /* ── exists ── */
    case "exists": {
      const full = await safePath(args.filePath);
      try {
        const stat = await fs.stat(full);
        return ok("exists", {
          path: args.filePath,
          data: { exists: true, type: stat.isDirectory() ? "dir" : "file", bytes: stat.size },
        });
      } catch {
        return ok("exists", { path: args.filePath, data: { exists: false } });
      }
    }

    /* ── stat ── */
    case "stat": {
      const full = await safePath(args.filePath);
      const stat = await fs.stat(full);
      return ok("stat", {
        path: args.filePath,
        bytes: stat.size,
        mtime: stat.mtime.toISOString(),
        data: {
          type: stat.isDirectory() ? "dir" : "file",
          size: stat.size,
          created: stat.birthtime.toISOString(),
          modified: stat.mtime.toISOString(),
          permissions: stat.mode.toString(8),
        },
      });
    }

    /* ── mkdir ── */
    case "mkdir": {
      const full = await safePath(args.filePath);
      await fs.mkdir(full, { recursive: true });
      return ok("mkdir", { path: args.filePath });
    }

    /* ── delete ── */
    case "delete": {
      const full = await safePath(args.filePath);
      const stat = await fs.stat(full);
      if (stat.isDirectory()) {
        await fs.rm(full, { recursive: true });
      } else {
        await fs.unlink(full);
      }
      return ok("delete", { path: args.filePath, bytes: stat.size });
    }

    /* ── rename ── */
    case "rename": {
      if (!args.destPath) throw new Error("destPath is required for rename");
      const srcFull = await safePath(args.filePath);
      const destFull = await safePath(args.destPath);
      await fs.mkdir(path.dirname(destFull), { recursive: true });
      await fs.rename(srcFull, destFull);
      return ok("rename", { path: args.filePath, data: { dest: args.destPath } });
    }

    /* ── copy ── */
    case "copy": {
      if (!args.destPath) throw new Error("destPath is required for copy");
      const srcFull = await safePath(args.filePath);
      const destFull = await safePath(args.destPath);
      const stat = await fs.stat(srcFull);
      if (stat.size > MAX_WRITE_BYTES) {
        throw new Error(`File too large to copy (${stat.size} bytes, max ${MAX_WRITE_BYTES})`);
      }
      await fs.mkdir(path.dirname(destFull), { recursive: true });
      await fs.copyFile(srcFull, destFull);
      return ok("copy", { path: args.filePath, bytes: stat.size, data: { dest: args.destPath } });
    }

    default:
      throw new Error(`Unknown action: ${action}. Available: ${ALL_ACTIONS.join(", ")}`);
  }
}
