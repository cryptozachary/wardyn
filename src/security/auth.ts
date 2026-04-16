import type { Request, Response, NextFunction } from "express";
import { createHmac, randomBytes, timingSafeEqual } from "crypto";

const COOKIE_NAME = "wardyn_auth";
const CSRF_COOKIE = "wardyn_csrf";
const CSRF_HEADER = "x-csrf-token";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

const isProd = () => process.env.NODE_ENV === "production";

export interface AuthConfig {
  apiToken: string | undefined;
  cookieSecret: string;
}

let cachedConfig: AuthConfig | null = null;

export function getAuthConfig(): AuthConfig {
  if (cachedConfig) return cachedConfig;
  cachedConfig = {
    apiToken: process.env.API_TOKEN,
    cookieSecret: process.env.COOKIE_SECRET || process.env.API_TOKEN || randomBytes(32).toString("hex"),
  };
  return cachedConfig;
}

export function resetAuthConfig() { cachedConfig = null; }

function sign(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value).digest("hex");
}

function safeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a); const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function issueSessionCookie(res: Response): string {
  const cfg = getAuthConfig();
  const expires = Date.now() + SESSION_TTL_MS;
  const payload = `${expires}.${randomBytes(16).toString("hex")}`;
  const token = `${payload}.${sign(payload, cfg.cookieSecret)}`;
  const flags = ["HttpOnly", "SameSite=Strict", "Path=/", `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`];
  if (isProd()) flags.push("Secure");
  res.append("Set-Cookie", `${COOKIE_NAME}=${token}; ${flags.join("; ")}`);

  const csrf = randomBytes(24).toString("hex");
  const csrfFlags = ["SameSite=Strict", "Path=/", `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`];
  if (isProd()) csrfFlags.push("Secure");
  res.append("Set-Cookie", `${CSRF_COOKIE}=${csrf}; ${csrfFlags.join("; ")}`);
  return token;
}

export function clearSessionCookie(res: Response) {
  res.append("Set-Cookie", `${COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0`);
  res.append("Set-Cookie", `${CSRF_COOKIE}=; Path=/; Max-Age=0`);
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function validSessionCookie(token: string, secret: string): boolean {
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [expStr, nonce, sig] = parts;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  const expected = sign(`${expStr}.${nonce}`, secret);
  return safeEq(expected, sig);
}

export function assertProdAuthConfig(): void {
  if (!isProd()) return;
  const missing: string[] = [];
  if (!process.env.API_TOKEN) missing.push("API_TOKEN");
  if (!process.env.KEY_PASSPHRASE) missing.push("KEY_PASSPHRASE");
  if (!process.env.COOKIE_SECRET) missing.push("COOKIE_SECRET");
  if (missing.length) {
    throw new Error(`[startup] Refusing to boot in production with missing env: ${missing.join(", ")}`);
  }
  if (process.env.API_TOKEN && process.env.API_TOKEN.length < 24) {
    throw new Error("[startup] API_TOKEN must be at least 24 characters in production");
  }
}

export function isAuthenticated(req: Request): boolean {
  const cfg = getAuthConfig();
  if (!cfg.apiToken) {
    // Dev-only: no token configured. Allowed only in non-prod.
    return !isProd();
  }
  const header = req.get("x-api-token");
  if (header && safeEq(header, cfg.apiToken)) return true;
  const cookies = parseCookies(req.headers.cookie);
  const sess = cookies[COOKIE_NAME];
  if (sess && validSessionCookie(sess, cfg.cookieSecret)) return true;
  return false;
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!isAuthenticated(req)) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  return next();
}

export function requireCsrf(req: Request, res: Response, next: NextFunction) {
  if (req.get("x-api-token")) return next();
  const method = req.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return next();
  const cookies = parseCookies(req.headers.cookie);
  const sess = cookies[COOKIE_NAME];
  if (!sess) return next(); // only enforce CSRF when the session cookie is in play
  const cookieVal = cookies[CSRF_COOKIE];
  const headerVal = req.get(CSRF_HEADER);
  if (!cookieVal || !headerVal || !safeEq(cookieVal, headerVal)) {
    return res.status(403).json({ ok: false, error: "csrf" });
  }
  return next();
}

export function authForBrowser(req: Request, res: Response, next: NextFunction) {
  if (isAuthenticated(req)) return next();
  const accepts = req.get("accept") || "";
  if (accepts.includes("text/html")) {
    return res.redirect(302, `/login?next=${encodeURIComponent(req.originalUrl)}`);
  }
  return res.status(401).json({ ok: false, error: "unauthorized" });
}

export function validateApiToken(submitted: string): boolean {
  const cfg = getAuthConfig();
  if (!cfg.apiToken) return false;
  return safeEq(submitted, cfg.apiToken);
}
