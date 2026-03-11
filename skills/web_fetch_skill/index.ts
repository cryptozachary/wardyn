import axios, { AxiosError } from "axios";
import dns from "dns/promises";
import { URL } from "url";

/* ────────────────────── parameters ────────────────────── */

export const parameters = {
  type: "object",
  properties: {
    url: { type: "string", description: "The URL to fetch (must start with http:// or https://)" },
    method: { type: "string", enum: ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD"], description: "HTTP method (default: GET)" },
    headers: { type: "object", description: "Optional HTTP headers (Authorization and Cookie are blocked by default)" },
    body: { type: "string", description: "Optional request body" },
    timeout: { type: "number", description: "Request timeout in ms (default: 10000, max: 30000)" },
    maxBodySize: { type: "number", description: "Max response body chars to return (default: 4000, max: 50000)" },
    retries: { type: "number", description: "Retry count for 429/5xx/timeouts (default: 0, max: 3)" },
    allowUnsafeHeaders: { type: "boolean", description: "Set true to allow Authorization/Cookie headers (default: false)" },
    allowlist: { type: "array", items: { type: "string" }, description: "Optional domain allowlist — only these domains allowed (e.g. ['api.example.com'])" },
    denylist: { type: "array", items: { type: "string" }, description: "Optional domain denylist — these domains blocked (e.g. ['evil.com'])" },
  },
  required: ["url"],
};

/* ────────────────────── SSRF protection ────────────────────── */

const BLOCKED_HOSTS = new Set([
  "localhost", "127.0.0.1", "0.0.0.0", "[::1]", "metadata.google.internal",
  "169.254.169.254",
]);

const PRIVATE_RANGES = [
  { start: 0x0A000000, end: 0x0AFFFFFF },   // 10.0.0.0/8
  { start: 0xAC100000, end: 0xAC1FFFFF },   // 172.16.0.0/12
  { start: 0xC0A80000, end: 0xC0A8FFFF },   // 192.168.0.0/16
  { start: 0x7F000000, end: 0x7FFFFFFF },   // 127.0.0.0/8
  { start: 0xA9FE0000, end: 0xA9FEFFFF },   // 169.254.0.0/16 (link-local)
];

function ipToInt(ip: string): number {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) return -1;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function isPrivateIp(ip: string): boolean {
  const n = ipToInt(ip);
  if (n < 0) return false;
  return PRIVATE_RANGES.some((r) => n >= r.start && n <= r.end);
}

async function assertSafeUrl(raw: string, allowlist?: string[], denylist?: string[]): Promise<URL> {
  if (!/^https?:\/\//i.test(raw)) throw new Error("URL must start with http:// or https://");
  const parsed = new URL(raw);
  const host = parsed.hostname.toLowerCase();

  // Domain allowlist check (if provided, only these domains are allowed)
  if (allowlist && allowlist.length > 0) {
    if (!allowlist.some((d) => host === d.toLowerCase() || host.endsWith("." + d.toLowerCase()))) {
      throw new Error(`Blocked: ${host} is not in the allowlist`);
    }
  }

  // Domain denylist check
  if (denylist && denylist.length > 0) {
    if (denylist.some((d) => host === d.toLowerCase() || host.endsWith("." + d.toLowerCase()))) {
      throw new Error(`Blocked: ${host} is in the denylist`);
    }
  }

  // Static host checks
  if (BLOCKED_HOSTS.has(host)) throw new Error(`Blocked: ${host} is not allowed (SSRF protection)`);
  if (isPrivateIp(host)) throw new Error(`Blocked: private IP ${host} is not allowed (SSRF protection)`);
  if (host.startsWith("[")) throw new Error("Blocked: IPv6 addresses are not allowed");
  if (/^0\./.test(host)) throw new Error("Blocked: 0.x.x.x addresses are not allowed");

  // DNS resolution check — catches domains that resolve to private IPs
  try {
    const { address } = await dns.lookup(host);
    if (BLOCKED_HOSTS.has(address) || isPrivateIp(address)) {
      throw new Error(`Blocked: ${host} resolves to private IP ${address} (SSRF protection)`);
    }
  } catch (err: any) {
    // Re-throw our own SSRF errors
    if (err.message?.includes("Blocked:")) throw err;
    // DNS failure — allow (will fail at network level)
  }

  return parsed;
}

/* ────────────────────── header safety ────────────────────── */

const DANGEROUS_HEADERS = new Set([
  "authorization", "cookie", "proxy-authorization",
]);

function sanitizeHeaders(
  headers: Record<string, string> | undefined,
  allowUnsafe: boolean,
): Record<string, string> {
  if (!headers || typeof headers !== "object") return {};
  if (allowUnsafe) return headers;
  const safe: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (DANGEROUS_HEADERS.has(k.toLowerCase())) continue;
    safe[k] = v;
  }
  return safe;
}

/* ────────────────────── HTML extraction ────────────────────── */

function stripHtml(html: string): string {
  return html
    // Remove script/style/noscript blocks entirely
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, "")
    // Remove nav, header, footer (common boilerplate)
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "")
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, " ")
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, " ")
    // Convert block elements to newlines for readability
    .replace(/<\/?(p|div|br|hr|h[1-6]|li|tr|blockquote|pre)[^>]*>/gi, "\n")
    // Strip remaining tags
    .replace(/<[^>]+>/g, " ")
    // Decode common entities
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&#\d+;/g, "")
    // Collapse whitespace but preserve paragraph breaks
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n/g, "\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/* ────────────────────── retry helper ────────────────────── */

function isRetryable(err: any): boolean {
  if (err instanceof AxiosError) {
    const status = err.response?.status;
    if (status === 429 || (status && status >= 500)) return true;
    if (err.code === "ECONNABORTED" || err.code === "ETIMEDOUT" || err.code === "ECONNRESET") return true;
  }
  return false;
}

async function withRetry<T>(fn: () => Promise<T>, maxRetries: number): Promise<T> {
  const max = Math.min(Math.max(maxRetries, 0), 3);
  let lastErr: Error | null = null;
  for (let i = 0; i <= max; i++) {
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      if (i < max && isRetryable(err)) {
        // Exponential backoff with jitter
        const base = Math.pow(2, i) * 500;
        const jitter = Math.random() * 500;
        await new Promise((r) => setTimeout(r, base + jitter));
        continue;
      }
      throw err;
    }
  }
  throw lastErr!;
}

/* ────────────────────── structured response ────────────────────── */

interface FetchResult {
  status: "ok" | "error";
  httpStatus?: number;
  url: string;
  contentType?: string;
  headers?: Record<string, string>;
  body?: string;
  truncated?: boolean;
  bytes?: number;
  elapsedMs: number;
  error?: string;
  retries?: number;
}

function ok(fields: Partial<FetchResult>, start: number): string {
  return JSON.stringify({ status: "ok", elapsedMs: Date.now() - start, ...fields });
}

function fail(url: string, error: string, start: number): string {
  return JSON.stringify({ status: "error", url, error, elapsedMs: Date.now() - start });
}

/* ────────────────────── constants ────────────────────── */

const DEFAULT_TIMEOUT = 10_000;
const MAX_TIMEOUT = 30_000;
const DEFAULT_MAX_BODY = 4000;
const ABSOLUTE_MAX_BODY = 50_000;
const MAX_CONTENT_LENGTH = 10 * 1024 * 1024; // 10 MB download limit

/* ────────────────────── execute ────────────────────── */

export async function execute(args: any): Promise<string> {
  const start = Date.now();
  const {
    url,
    method = "GET",
    headers,
    body,
    timeout = DEFAULT_TIMEOUT,
    maxBodySize = DEFAULT_MAX_BODY,
    retries = 0,
    allowUnsafeHeaders = false,
    allowlist,
    denylist,
  } = args;

  if (!url || typeof url !== "string") return fail("", "url is required", start);

  try {
    // SSRF + domain policy check
    await assertSafeUrl(url, allowlist, denylist);

    const safeHeaders = sanitizeHeaders(headers, allowUnsafeHeaders);
    const effectiveTimeout = Math.min(Number(timeout) || DEFAULT_TIMEOUT, MAX_TIMEOUT);
    const effectiveMaxBody = Math.min(Number(maxBodySize) || DEFAULT_MAX_BODY, ABSOLUTE_MAX_BODY);

    const res = await withRetry(
      () =>
        axios({
          url,
          method: method.toUpperCase(),
          headers: safeHeaders,
          data: body,
          timeout: effectiveTimeout,
          maxRedirects: 5,
          maxContentLength: MAX_CONTENT_LENGTH,
          responseType: "text",
          validateStatus: () => true,
        }),
      retries,
    );

    const contentType = res.headers["content-type"] || "unknown";
    let responseBody = typeof res.data === "string" ? res.data : JSON.stringify(res.data, null, 2);
    const rawBytes = Buffer.byteLength(responseBody, "utf8");

    // Strip HTML for cleaner output
    if (contentType.includes("text/html")) {
      responseBody = stripHtml(responseBody);
    }

    const truncated = responseBody.length > effectiveMaxBody;
    if (truncated) {
      responseBody = responseBody.slice(0, effectiveMaxBody);
    }

    // Pick useful response headers to include
    const selectedHeaders: Record<string, string> = {};
    for (const h of ["content-type", "content-length", "x-ratelimit-remaining", "retry-after", "location"]) {
      if (res.headers[h]) selectedHeaders[h] = String(res.headers[h]);
    }

    return ok(
      {
        httpStatus: res.status,
        url,
        contentType,
        headers: selectedHeaders,
        body: responseBody,
        truncated,
        bytes: rawBytes,
      },
      start,
    );
  } catch (err: any) {
    const msg = err instanceof AxiosError
      ? `HTTP error: ${err.message}${err.response?.status ? ` (${err.response.status})` : ""}`
      : err.message;
    return fail(url, msg, start);
  }
}
