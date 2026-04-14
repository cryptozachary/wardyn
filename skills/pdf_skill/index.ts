import { promises as fs } from "fs";
import path from "path";
import { execFile } from "child_process";

export const parameters = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["extract", "info"],
      description: "PDF action: extract (get text), info (page count and metadata)",
    },
    filePath: { type: "string", description: "Relative path to PDF file inside sandbox (e.g. 'report.pdf')" },
    pages: { type: "string", description: "Page range for extract (e.g. '1-5', '3', '1,3,5'). Default: all pages." },
    maxChars: { type: "number", description: "Max characters to return (default: 10000, max: 50000)" },
  },
  required: ["action", "filePath"],
};

/* ────────────────────── constants ────────────────────── */

const SANDBOX_DIR = path.join(process.cwd(), "sandbox");
const UPLOADS_DIR = path.join(process.cwd(), "uploads");
const ALLOWED_DIRS = [SANDBOX_DIR, UPLOADS_DIR];
const DEFAULT_MAX_CHARS = 10000;
const ABSOLUTE_MAX_CHARS = 50000;
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
const TIMEOUT = 30000;

/* ────────────────────── path safety ────────────────────── */

async function safePath(filePath: string): Promise<string> {
  if (!filePath || typeof filePath !== "string") throw new Error("filePath is required");

  // Support absolute paths that point into allowed directories (sandbox or uploads)
  let resolved: string;
  if (path.isAbsolute(filePath)) {
    resolved = path.resolve(filePath);
  } else {
    // Try sandbox first, fall back to uploads for relative paths
    resolved = path.resolve(SANDBOX_DIR, filePath);
    try {
      await fs.access(resolved);
    } catch {
      const uploadsResolved = path.resolve(UPLOADS_DIR, filePath);
      try {
        await fs.access(uploadsResolved);
        resolved = uploadsResolved;
      } catch { /* keep sandbox path — will error later with proper message */ }
    }
  }

  // Check that resolved path is within an allowed directory
  const inAllowed = ALLOWED_DIRS.some(dir => {
    const normalDir = path.resolve(dir) + path.sep;
    return resolved.startsWith(normalDir) || resolved === path.resolve(dir);
  });
  if (!inAllowed) {
    throw new Error("Path must be within sandbox or uploads directory");
  }

  try {
    const real = await fs.realpath(resolved);
    const realInAllowed = ALLOWED_DIRS.some(dir => {
      const normalDir = path.resolve(dir) + path.sep;
      return real.startsWith(normalDir) || real === path.resolve(dir);
    });
    if (!realInAllowed) {
      throw new Error("Path escapes allowed directories (symlink detected)");
    }
    return real;
  } catch (err: any) {
    if (err.code === "ENOENT") throw new Error(`File not found: ${filePath}`);
    if (err.message?.includes("allowed") || err.message?.includes("sandbox")) throw err;
    return resolved;
  }
}

/* ────────────────────── PDF text extraction ────────────────────── */

/**
 * Extract text from PDF using multiple strategies:
 * 1. pdf-parse v2 (pure JS — works on all platforms)
 * 2. Try pdftotext (poppler-utils) if available
 * 3. Fall back to basic binary text extraction
 */
async function extractText(filePath: string, pages?: string): Promise<string> {
  // Strategy 1: pdf-parse v2 (pure JS — no external tools required)
  try {
    const { PDFParse, VerbosityLevel } = await import("pdf-parse");
    const buf = await fs.readFile(filePath);
    const parseParams: any = {};
    if (pages) {
      const match = pages.match(/^(\d+)(?:\s*-\s*(\d+))?$/);
      if (match) {
        const first = parseInt(match[1], 10);
        const last = match[2] ? parseInt(match[2], 10) : first;
        parseParams.partial = Array.from({ length: last - first + 1 }, (_, i) => first + i);
      } else if (/^\d+(,\s*\d+)*$/.test(pages)) {
        parseParams.partial = pages.split(",").map((p: string) => parseInt(p.trim(), 10));
      }
    }
    const parser = new PDFParse({ data: new Uint8Array(buf), verbosity: VerbosityLevel.ERRORS });
    const result = await parser.getText(parseParams);
    await parser.destroy();
    if (result.text?.trim().length > 0) return result.text;
  } catch {
    // pdf-parse failed, fall back
  }

  // Strategy 2: pdftotext (poppler-utils) if installed
  try {
    const args = ["-layout"];
    if (pages) {
      const match = pages.match(/^(\d+)(?:\s*-\s*(\d+))?$/);
      if (match) {
        args.push("-f", match[1]);
        if (match[2]) args.push("-l", match[2]);
      }
    }
    args.push(filePath, "-");
    const text = await runCmd("pdftotext", args);
    if (text.trim().length > 0) return text;
  } catch {
    // pdftotext not available
  }

  // Strategy 3: Basic binary text extraction (last resort)
  return await basicExtract(filePath);
}

/** Basic extraction — pull readable text strings from PDF binary */
async function basicExtract(filePath: string): Promise<string> {
  const buf = await fs.readFile(filePath);
  const text = buf.toString("latin1");

  const chunks: string[] = [];

  // Extract text between BT/ET (text objects) in PDF streams
  const streamPattern = /stream\r?\n([\s\S]*?)endstream/g;
  let match;
  while ((match = streamPattern.exec(text)) !== null) {
    const stream = match[1];
    // Extract text from Tj and TJ operators
    const tjPattern = /\(([^)]*)\)\s*Tj/g;
    let tjMatch;
    while ((tjMatch = tjPattern.exec(stream)) !== null) {
      const decoded = tjMatch[1]
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "\r")
        .replace(/\\t/g, "\t")
        .replace(/\\\(/g, "(")
        .replace(/\\\)/g, ")")
        .replace(/\\\\/g, "\\");
      if (decoded.trim()) chunks.push(decoded);
    }
  }

  if (chunks.length > 0) return chunks.join(" ");

  // Absolute last resort — extract any printable ASCII sequences
  const printable = text.match(/[\x20-\x7E]{4,}/g) || [];
  return printable
    .filter((s) => !/^[%\/\[\]<>{}]+$/.test(s)) // filter PDF syntax
    .filter((s) => !/^(obj|endobj|stream|endstream|xref|trailer)/.test(s))
    .join(" ")
    .slice(0, 5000);
}

/** Get PDF metadata/info */
async function getPdfInfo(filePath: string): Promise<any> {
  const buf = await fs.readFile(filePath);
  const text = buf.toString("latin1");

  // Count pages
  const pageCount = (text.match(/\/Type\s*\/Page\b/g) || []).length;

  // Extract basic metadata from /Info dictionary
  const info: Record<string, string> = {};
  const metaPatterns = [
    { key: "Title", pattern: /\/Title\s*\(([^)]*)\)/ },
    { key: "Author", pattern: /\/Author\s*\(([^)]*)\)/ },
    { key: "Subject", pattern: /\/Subject\s*\(([^)]*)\)/ },
    { key: "Creator", pattern: /\/Creator\s*\(([^)]*)\)/ },
    { key: "Producer", pattern: /\/Producer\s*\(([^)]*)\)/ },
  ];

  for (const { key, pattern } of metaPatterns) {
    const m = text.match(pattern);
    if (m) info[key] = m[1];
  }

  return {
    pages: pageCount || "unknown",
    size: buf.length,
    ...info,
  };
}

/* ────────────────────── execute ────────────────────── */

export async function execute(args: any): Promise<string> {
  const start = Date.now();
  const { action, filePath: relPath, pages, maxChars = DEFAULT_MAX_CHARS } = args;

  try {
    const full = await safePath(relPath);
    const stat = await fs.stat(full);

    if (!stat.isFile()) throw new Error("Not a file");
    if (stat.size > MAX_FILE_SIZE) throw new Error(`PDF too large (${(stat.size / 1024 / 1024).toFixed(1)}MB, max 50MB)`);
    if (!full.toLowerCase().endsWith(".pdf")) throw new Error("File must be a .pdf");

    switch (action) {
      case "extract": {
        const limit = Math.min(Number(maxChars) || DEFAULT_MAX_CHARS, ABSOLUTE_MAX_CHARS);
        let text = await extractText(full, pages);
        text = text.replace(/\s+/g, " ").trim();

        const truncated = text.length > limit;
        if (truncated) text = text.slice(0, limit);

        return JSON.stringify({
          status: "ok",
          action: "extract",
          path: relPath,
          chars: text.length,
          truncated,
          text,
          elapsedMs: Date.now() - start,
        });
      }

      case "info": {
        const info = await getPdfInfo(full);
        return JSON.stringify({
          status: "ok",
          action: "info",
          path: relPath,
          ...info,
          elapsedMs: Date.now() - start,
        });
      }

      default:
        throw new Error(`Unknown action: ${action}. Use: extract, info`);
    }
  } catch (err: any) {
    return JSON.stringify({ status: "error", action, error: err.message, elapsedMs: Date.now() - start });
  }
}

/* ────────────────────── helpers ────────────────────── */

function runCmd(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: TIMEOUT, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr?.trim() || err.message));
      resolve(stdout);
    });
  });
}
