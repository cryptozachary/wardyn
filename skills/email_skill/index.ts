import { createTransport, Transporter } from "nodemailer";
import { getSkillSecret } from "../../src/security/skillSecrets.js";
import { promises as fs } from "fs";
import path from "path";

export const parameters = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["send", "verify"],
      description: "Email action: send (send email) or verify (test SMTP connection)",
    },
    to: {
      type: "array",
      items: { type: "string" },
      description: "Recipient email addresses (required for send)",
    },
    subject: { type: "string", description: "Email subject (required for send)" },
    body: { type: "string", description: "Email body text (required for send)" },
    html: { type: "string", description: "Optional HTML body (overrides body if provided)" },
    cc: {
      type: "array",
      items: { type: "string" },
      description: "CC recipients",
    },
    bcc: {
      type: "array",
      items: { type: "string" },
      description: "BCC recipients",
    },
    attachments: {
      type: "array",
      items: { type: "string" },
      description: "File paths (relative to sandbox/ or output/) to attach",
    },
  },
  required: ["action"],
};

export const secrets = {
  SMTP_HOST: { description: "SMTP server hostname (e.g. smtp.gmail.com)", required: true },
  SMTP_PORT: { description: "SMTP port (e.g. 587 for TLS, 465 for SSL)", required: true },
  SMTP_USER: { description: "SMTP username / email address", required: true },
  SMTP_PASS: { description: "SMTP password or app-specific password", required: true },
  SMTP_FROM: { description: "From address (defaults to SMTP_USER if not set)", required: false },
  EMAIL_DOMAIN_ALLOWLIST: {
    description: "Comma-separated list of allowed recipient domains (e.g. 'example.com,corp.io'). Empty = allow all.",
    required: false,
  },
  EMAIL_RATE_LIMIT: {
    description: "Max emails per hour (default: 20). Set to 0 for unlimited.",
    required: false,
  },
};

/* ────────────────────── constants ────────────────────── */

const EMAIL_REGEX = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
const HEADER_INJECTION_RE = /[\r\n]/;
const MAX_RECIPIENTS = 20;
const MAX_SUBJECT_LENGTH = 500;
const MAX_BODY_SIZE = 100_000; // 100KB
const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024; // 10MB
const ALLOWED_ATTACHMENT_EXTENSIONS = new Set([
  ".txt", ".csv", ".json", ".xml", ".pdf", ".png", ".jpg", ".jpeg",
  ".gif", ".webp", ".html", ".md", ".log", ".zip",
]);
const DEFAULT_RATE_LIMIT = 20; // per hour
const SANDBOX_DIR = path.join(process.cwd(), "sandbox");
const OUTPUT_DIR = path.join(process.cwd(), "output");

/* ────────────────────── rate limiter ────────────────────── */

const sendTimestamps: number[] = [];

function checkRateLimit(maxPerHour: number): void {
  if (maxPerHour <= 0) return; // 0 = unlimited
  const oneHourAgo = Date.now() - 3_600_000;
  // Prune old entries
  while (sendTimestamps.length > 0 && sendTimestamps[0] < oneHourAgo) {
    sendTimestamps.shift();
  }
  if (sendTimestamps.length >= maxPerHour) {
    throw new Error(`Rate limit exceeded: ${maxPerHour} emails per hour. Try again later.`);
  }
}

function recordSend(): void {
  sendTimestamps.push(Date.now());
}

/* ────────────────────── validation ────────────────────── */

function validateEmail(addr: string): string {
  const trimmed = addr.trim();
  if (!EMAIL_REGEX.test(trimmed)) {
    throw new Error(`Invalid email address: "${trimmed}"`);
  }
  return trimmed;
}

function validateEmails(input: any): string[] {
  if (!input) return [];
  // Accept string (comma-separated) or array
  const list: string[] = Array.isArray(input)
    ? input
    : typeof input === "string"
      ? input.split(",")
      : [];
  const validated = list.map(validateEmail).filter(Boolean);
  if (validated.length > MAX_RECIPIENTS) {
    throw new Error(`Too many recipients (max ${MAX_RECIPIENTS})`);
  }
  return validated;
}

function assertNoInjection(field: string, value: string): void {
  if (HEADER_INJECTION_RE.test(value)) {
    throw new Error(`Header injection detected in ${field}: newline characters not allowed`);
  }
}

function checkDomainAllowlist(emails: string[], allowlist: string[]): void {
  if (allowlist.length === 0) return;
  const allowedDomains = new Set(allowlist.map((d) => d.toLowerCase().trim()));
  for (const email of emails) {
    const domain = email.split("@")[1]?.toLowerCase();
    if (!domain || !allowedDomains.has(domain)) {
      throw new Error(`Recipient domain "${domain}" not in allowlist. Allowed: ${[...allowedDomains].join(", ")}`);
    }
  }
}

/* ────────────────────── attachment safety ────────────────────── */

async function resolveAttachment(filePath: string): Promise<{ filename: string; path: string }> {
  if (path.isAbsolute(filePath)) {
    throw new Error(`Absolute attachment paths not allowed: "${filePath}"`);
  }

  // Try output/ first, then sandbox/
  let resolved: string | null = null;
  for (const baseDir of [OUTPUT_DIR, SANDBOX_DIR]) {
    const candidate = path.resolve(baseDir, filePath);
    const normalBase = path.resolve(baseDir) + path.sep;
    if (candidate.startsWith(normalBase) || candidate === path.resolve(baseDir)) {
      try {
        await fs.access(candidate);
        resolved = candidate;
        break;
      } catch {
        // Try next base
      }
    }
  }

  if (!resolved) {
    throw new Error(`Attachment not found or outside allowed directories (output/, sandbox/): "${filePath}"`);
  }

  // Extension check
  const ext = path.extname(resolved).toLowerCase();
  if (!ALLOWED_ATTACHMENT_EXTENSIONS.has(ext)) {
    throw new Error(`Attachment type "${ext}" not allowed. Allowed: ${[...ALLOWED_ATTACHMENT_EXTENSIONS].join(", ")}`);
  }

  // Size check
  const stat = await fs.stat(resolved);
  if (stat.size > MAX_ATTACHMENT_SIZE) {
    throw new Error(`Attachment too large: ${(stat.size / 1024 / 1024).toFixed(1)}MB (max ${MAX_ATTACHMENT_SIZE / 1024 / 1024}MB)`);
  }

  return { filename: path.basename(resolved), path: resolved };
}

/* ────────────────────── retry helper ────────────────────── */

function isTransientError(err: any): boolean {
  const code = err.responseCode || err.code;
  // 4xx SMTP errors are transient, 5xx are permanent
  if (typeof code === "number" && code >= 400 && code < 500) return true;
  // Network errors
  if (["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "ESOCKET"].includes(err.code)) return true;
  return false;
}

async function withRetry<T>(fn: () => Promise<T>, maxRetries: number): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      if (attempt < maxRetries && isTransientError(err)) {
        const delay = Math.pow(2, attempt) * 1000 + Math.random() * 500;
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
  throw new Error("Retry exhausted"); // unreachable
}

/* ────────────────────── transport factory ────────────────────── */

function createSmtpTransport(): Transporter {
  const host = getSkillSecret("email_skill", "SMTP_HOST");
  const port = getSkillSecret("email_skill", "SMTP_PORT");
  const user = getSkillSecret("email_skill", "SMTP_USER");
  const pass = getSkillSecret("email_skill", "SMTP_PASS");

  if (!host || !user || !pass) {
    throw new Error("Email not configured. Set SMTP_HOST, SMTP_USER, and SMTP_PASS in Skill Secrets on the Setup page.");
  }

  const portNum = parseInt(port, 10) || 587;
  return createTransport({
    host,
    port: portNum,
    secure: portNum === 465,
    auth: { user, pass },
    connectionTimeout: 10000,
    socketTimeout: 10000,
  });
}

/* ────────────────────── execute ────────────────────── */

export async function execute(args: any): Promise<string> {
  const start = Date.now();
  const { action } = args;

  try {
    switch (action) {
      case "send": {
        const { subject, body, html, attachments } = args;

        // Fix #1: Strong recipient validation — to, cc, bcc as arrays
        const to = validateEmails(args.to);
        const cc = validateEmails(args.cc);
        const bcc = validateEmails(args.bcc);

        if (to.length === 0) throw new Error("At least one 'to' recipient is required");
        if (!subject) throw new Error("subject is required");
        if (!body && !html) throw new Error("body or html is required");

        // Fix #2: Header injection protection
        assertNoInjection("subject", subject);
        const fromAddr = getSkillSecret("email_skill", "SMTP_FROM") || getSkillSecret("email_skill", "SMTP_USER") || "";
        if (fromAddr) assertNoInjection("from", fromAddr);
        for (const addr of [...to, ...cc, ...bcc]) assertNoInjection("recipient", addr);

        if (subject.length > MAX_SUBJECT_LENGTH) {
          throw new Error(`Subject too long (max ${MAX_SUBJECT_LENGTH} chars)`);
        }
        const bodySize = (body?.length || 0) + (html?.length || 0);
        if (bodySize > MAX_BODY_SIZE) {
          throw new Error(`Body too large (${(bodySize / 1024).toFixed(0)}KB, max ${MAX_BODY_SIZE / 1024}KB)`);
        }

        // Fix #4: Domain allowlist
        const allowlistRaw = getSkillSecret("email_skill", "EMAIL_DOMAIN_ALLOWLIST") || "";
        const allowlist = allowlistRaw ? allowlistRaw.split(",").map((d) => d.trim()).filter(Boolean) : [];
        checkDomainAllowlist([...to, ...cc, ...bcc], allowlist);

        // Fix #4: Rate limit
        const rateLimitStr = getSkillSecret("email_skill", "EMAIL_RATE_LIMIT");
        const rateLimit = rateLimitStr ? parseInt(rateLimitStr, 10) : DEFAULT_RATE_LIMIT;
        checkRateLimit(rateLimit);

        // Fix #6: Safe attachments
        const resolvedAttachments: Array<{ filename: string; path: string }> = [];
        if (attachments && Array.isArray(attachments)) {
          for (const att of attachments) {
            resolvedAttachments.push(await resolveAttachment(att));
          }
        }

        // Fix #3: Create transport and verify connection
        const transport = createSmtpTransport();
        try {
          await transport.verify();
        } catch (err: any) {
          throw new Error(`SMTP connection failed: ${err.message}. Check SMTP_HOST, SMTP_PORT, SMTP_USER, and SMTP_PASS.`);
        }

        // Fix #5: Retry transient failures
        const info = await withRetry(
          () =>
            transport.sendMail({
              from: fromAddr,
              to: to.join(", "),
              cc: cc.length > 0 ? cc.join(", ") : undefined,
              bcc: bcc.length > 0 ? bcc.join(", ") : undefined,
              subject,
              text: body || undefined,
              html: html || undefined,
              attachments: resolvedAttachments.length > 0 ? resolvedAttachments : undefined,
            }),
          2, // up to 2 retries
        );

        recordSend();

        // Fix #7: Better structured response
        return JSON.stringify({
          status: "ok",
          action: "send",
          messageId: info.messageId,
          accepted: info.accepted || [],
          rejected: info.rejected || [],
          response: info.response,
          recipientCount: to.length + cc.length + bcc.length,
          hasAttachments: resolvedAttachments.length > 0,
          attachmentCount: resolvedAttachments.length,
          elapsedMs: Date.now() - start,
        });
      }

      case "verify": {
        // Fix #3: Test SMTP connection without sending
        const transport = createSmtpTransport();
        try {
          await transport.verify();
          return JSON.stringify({
            status: "ok",
            action: "verify",
            message: "SMTP connection successful",
            elapsedMs: Date.now() - start,
          });
        } catch (err: any) {
          return JSON.stringify({
            status: "error",
            action: "verify",
            error: `SMTP connection failed: ${err.message}`,
            errorCode: err.code || err.responseCode || null,
            elapsedMs: Date.now() - start,
          });
        }
      }

      default:
        throw new Error(`Unknown action: ${action}. Available: send, verify`);
    }
  } catch (err: any) {
    // Normalize error category
    const category = categorizeError(err);
    return JSON.stringify({
      status: "error",
      action,
      error: err.message,
      errorCategory: category,
      errorCode: err.responseCode || err.code || null,
      elapsedMs: Date.now() - start,
    });
  }
}

/* ────────────────────── error categorization ────────────────────── */

function categorizeError(err: any): string {
  const code = err.responseCode || err.code;
  if (err.message?.includes("not configured") || err.message?.includes("SMTP connection failed")) return "config";
  if (err.message?.includes("Header injection")) return "injection";
  if (err.message?.includes("allowlist")) return "policy";
  if (err.message?.includes("Rate limit")) return "rate_limit";
  if (err.message?.includes("Invalid email")) return "validation";
  if (err.message?.includes("Attachment")) return "attachment";
  if (typeof code === "number" && code >= 500) return "permanent_failure";
  if (typeof code === "number" && code >= 400) return "transient_failure";
  if (["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED"].includes(err.code)) return "network";
  return "unknown";
}
