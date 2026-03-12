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
const DEFAULT_MAX_CHARS = 10000;
const ABSOLUTE_MAX_CHARS = 50000;
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
const TIMEOUT = 30000;

/* ────────────────────── path safety ────────────────────── */

async function safePath(relPath: string): Promise<string> {
  if (!relPath || typeof relPath !== "string") throw new Error("filePath is required");
  if (path.isAbsolute(relPath)) throw new Error("Absolute paths not allowed");

  const resolved = path.resolve(SANDBOX_DIR, relPath);
  const normalSandbox = path.resolve(SANDBOX_DIR) + path.sep;
  if (!resolved.startsWith(normalSandbox) && resolved !== path.resolve(SANDBOX_DIR)) {
    throw new Error("Path escapes sandbox boundary");
  }

  try {
    const real = await fs.realpath(resolved);
    if (!real.startsWith(normalSandbox) && real !== path.resolve(SANDBOX_DIR)) {
      throw new Error("Path escapes sandbox (symlink detected)");
    }
    return real;
  } catch (err: any) {
    if (err.code === "ENOENT") throw new Error(`File not found: ${relPath}`);
    if (err.message?.includes("sandbox")) throw err;
    return resolved;
  }
}

/* ────────────────────── PDF text extraction ────────────────────── */

/**
 * Extract text from PDF using multiple strategies:
 * 1. Try pdftotext (poppler-utils) if available — best quality
 * 2. Fall back to basic binary text extraction
 */
async function extractText(filePath: string, pages?: string): Promise<string> {
  // Strategy 1: pdftotext (best quality)
  try {
    const args = ["-layout"];
    if (pages) {
      // pdftotext uses -f (first) and -l (last) for page ranges
      const match = pages.match(/^(\d+)(?:\s*-\s*(\d+))?$/);
      if (match) {
        args.push("-f", match[1]);
        if (match[2]) args.push("-l", match[2]);
      }
    }
    args.push(filePath, "-"); // output to stdout

    const text = await runCmd("pdftotext", args);
    if (text.trim().length > 0) return text;
  } catch {
    // pdftotext not available, fall back
  }

  // Strategy 2: python with PyPDF2/pypdf if available
  try {
    const script = `
import sys
try:
    from pypdf import PdfReader
except ImportError:
    from PyPDF2 import PdfReader
reader = PdfReader("${filePath.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}")
pages_arg = "${pages || ""}"
if pages_arg:
    parts = pages_arg.replace(" ", "").split(",")
    indices = []
    for p in parts:
        if "-" in p:
            start, end = p.split("-")
            indices.extend(range(int(start)-1, int(end)))
        else:
            indices.append(int(p)-1)
else:
    indices = range(len(reader.pages))
for i in indices:
    if 0 <= i < len(reader.pages):
        text = reader.pages[i].extract_text()
        if text:
            print(text)
            print("---PAGE BREAK---")
`;
    const text = await runCmd("python3", ["-c", script]);
    if (text.trim().length > 0) return text.replace(/---PAGE BREAK---\n?/g, "\n\n");
  } catch {
    // python/pypdf not available
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
