import { chromium } from "playwright";
import type { Browser, BrowserContext, Page } from "playwright";
import { promises as fs } from "fs";
import path from "path";
import { URL } from "url";
import dns from "dns/promises";
import type { Message } from "../../src/types.js";

/* ────────────────────── parameters ────────────────────── */

const ALL_ACTIONS = [
  "navigate", "screenshot", "click", "type", "evaluate", "read_text",
  "get_links", "scroll", "back", "forward", "select", "hover", "wait",
  "cookies", "open_tab", "switch_tab", "close_tab", "extract", "close",
] as const;

export const parameters = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: [...ALL_ACTIONS],
      description: "The browser action to perform",
    },
    url: { type: "string", description: "URL for navigate / open_tab" },
    selector: { type: "string", description: "CSS selector for click/type/read_text/hover/select/screenshot/extract" },
    text: { type: "string", description: "Text for type action" },
    script: { type: "string", description: "JS expression for evaluate (requires unsafe:true)" },
    unsafe: { type: "boolean", description: "Set true to allow evaluate action" },
    waitUntil: { type: "string", enum: ["domcontentloaded", "networkidle", "load", "commit"], description: "Wait strategy for navigate (default: domcontentloaded)" },
    waitFor: { type: "string", description: "CSS selector to wait for before performing the action" },
    timeout: { type: "number", description: "Action timeout in ms (default: 10000)" },
    direction: { type: "string", enum: ["up", "down", "left", "right"], description: "Scroll direction" },
    amount: { type: "number", description: "Scroll amount in pixels (default: 500)" },
    tabIndex: { type: "number", description: "Tab index for switch_tab (0-based)" },
    fields: { type: "object", description: "Schema for extract: { fieldName: 'CSS selector', ... }" },
    value: { type: "string", description: "Value for select action (option value)" },
    blockImages: { type: "boolean", description: "Block image loading (default: true)" },
    blockFonts: { type: "boolean", description: "Block font loading (default: true)" },
    fullPage: { type: "boolean", description: "Full page screenshot (default: false)" },
    cookie: { type: "object", description: "Cookie object for cookies set action: { name, value, domain?, path? }" },
    cookieAction: { type: "string", enum: ["get", "set", "clear"], description: "Cookie sub-action (default: get)" },
    retries: { type: "number", description: "Retry count for transient failures (default: 0, max: 3)" },
  },
  required: ["action"],
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

function assertSafeUrl(raw: string): URL {
  if (!/^https?:\/\//i.test(raw)) throw new Error("URL must start with http:// or https://");
  const parsed = new URL(raw);
  const host = parsed.hostname.toLowerCase();

  if (BLOCKED_HOSTS.has(host)) throw new Error(`Blocked: navigation to ${host} is not allowed (SSRF protection)`);
  if (isPrivateIp(host)) throw new Error(`Blocked: navigation to private IP ${host} is not allowed (SSRF protection)`);

  // Block IPv6 shorthand for loopback / private
  if (host.startsWith("[")) throw new Error("Blocked: IPv6 addresses are not allowed");
  // Block 0.x.x.x (alternative loopback)
  if (/^0\./.test(host)) throw new Error("Blocked: navigation to 0.x.x.x is not allowed");

  return parsed;
}

/** Check if a hostname resolves to a private/blocked IP (catches redirects & DNS rebinding). */
async function isBlockedHost(hostname: string): Promise<boolean> {
  if (BLOCKED_HOSTS.has(hostname)) return true;
  if (isPrivateIp(hostname)) return true;
  if (hostname.startsWith("[") || /^0\./.test(hostname)) return true;
  try {
    const { address } = await dns.lookup(hostname);
    if (BLOCKED_HOSTS.has(address) || isPrivateIp(address)) return true;
  } catch {
    // DNS failure — allow (will fail at network level anyway)
  }
  return false;
}

/** Install a request interceptor on the context that blocks all requests to private/internal hosts. */
async function installSsrfGuard(context: BrowserContext): Promise<void> {
  await context.route("**/*", async (route) => {
    try {
      const url = new URL(route.request().url());
      if (await isBlockedHost(url.hostname.toLowerCase())) {
        await route.abort("blockedbyclient");
        return;
      }
    } catch {
      // Malformed URL — let it through to fail naturally
    }
    await route.continue();
  });
}

/* ────────────────────── session management ────────────────────── */

interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  pages: Page[];
  activeTab: number;
  lastUsed: number;
  resourcePolicy: { blockImages: boolean; blockFonts: boolean };
}

const sessions = new Map<string, BrowserSession>();
const SESSION_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_SESSIONS = 10;

let cleanupTimer: ReturnType<typeof setInterval> | null = null;

function startCleanupLoop() {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [sid, s] of sessions) {
      if (now - s.lastUsed > SESSION_TTL_MS) {
        s.browser.close().catch(() => {});
        sessions.delete(sid);
      }
    }
    if (sessions.size === 0 && cleanupTimer) {
      clearInterval(cleanupTimer);
      cleanupTimer = null;
    }
  }, 30_000);
}

function sessionKey(meta?: Message): string {
  if (!meta) return "default";
  return `${meta.channel}:${meta.userId}`;
}

async function getSession(args: any, meta?: Message): Promise<BrowserSession> {
  const sid = sessionKey(meta);
  let s = sessions.get(sid);

  if (s) {
    s.lastUsed = Date.now();
    return s;
  }

  // Evict oldest session if at capacity
  if (sessions.size >= MAX_SESSIONS) {
    let oldest: string | null = null;
    let oldestTime = Infinity;
    for (const [id, sess] of sessions) {
      if (sess.lastUsed < oldestTime) { oldest = id; oldestTime = sess.lastUsed; }
    }
    if (oldest) {
      const evict = sessions.get(oldest)!;
      await evict.browser.close().catch(() => {});
      sessions.delete(oldest);
    }
  }

  const blockImages = args.blockImages !== false; // default true
  const blockFonts = args.blockFonts !== false;   // default true

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  });

  // SSRF guard — block all requests to private/internal hosts (covers redirects)
  await installSsrfGuard(context);

  // Apply resource blocking policy
  const blockPatterns: string[] = [];
  if (blockImages) blockPatterns.push("**/*.{png,jpg,jpeg,gif,svg,webp}");
  if (blockFonts) blockPatterns.push("**/*.{woff,woff2,ttf,eot}");
  if (blockPatterns.length > 0) {
    for (const pat of blockPatterns) {
      await context.route(pat, (route) => route.abort());
    }
  }

  const page = await context.newPage();
  s = {
    browser,
    context,
    pages: [page],
    activeTab: 0,
    lastUsed: Date.now(),
    resourcePolicy: { blockImages, blockFonts },
  };
  sessions.set(sid, s);
  startCleanupLoop();
  return s;
}

function activePage(s: BrowserSession): Page {
  return s.pages[s.activeTab];
}

/* ────────────────────── retry helper ────────────────────── */

const IDEMPOTENT_ACTIONS = new Set([
  "navigate", "screenshot", "read_text", "scroll", "back", "forward",
  "wait", "extract", "hover", "switch_tab",
]);

async function withRetry<T>(fn: () => Promise<T>, retries: number): Promise<T> {
  const max = Math.min(Math.max(retries, 0), 3);
  let lastErr: Error | null = null;
  for (let i = 0; i <= max; i++) {
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      if (i < max) await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
  throw lastErr!;
}

/* ────────────────────── structured response ────────────────────── */

interface BrowserResult {
  status: "ok" | "error";
  action: string;
  url?: string;
  title?: string;
  text?: string;
  path?: string;
  elapsedMs: number;
  data?: any;
  links?: { text: string; href: string }[];
  total?: number;
  returned?: number;
  error?: string;
}

function ok(action: string, fields: Partial<BrowserResult>, start: number): string {
  const result: BrowserResult = { status: "ok", action, elapsedMs: Date.now() - start, ...fields };
  return JSON.stringify(result);
}

function fail(action: string, error: string, start: number): string {
  const result: BrowserResult = { status: "error", action, error, elapsedMs: Date.now() - start };
  return JSON.stringify(result);
}

/* ────────────────────── output directory ────────────────────── */

const OUTPUT_DIR = path.join(process.cwd(), "output");

/* ────────────────────── execute ────────────────────── */

export async function execute(args: any, meta?: Message): Promise<string> {
  const start = Date.now();
  const { action } = args;
  if (!action || typeof action !== "string") {
    return fail("unknown", "action is required", start);
  }

  const retries = args.retries ?? 0;
  const timeout = args.timeout ?? 10000;

  // close doesn't need a session
  if (action === "close") {
    return closeSession(meta, start);
  }

  try {
    const effectiveRetries = IDEMPOTENT_ACTIONS.has(action) ? retries : 0;
    return await withRetry(() => doAction(action, args, meta, timeout, start), effectiveRetries);
  } catch (err: any) {
    return fail(action, err.message, start);
  }
}

async function closeSession(meta: Message | undefined, start: number): Promise<string> {
  const sid = sessionKey(meta);
  const s = sessions.get(sid);
  if (s) {
    await s.browser.close().catch(() => {});
    sessions.delete(sid);
  }
  return ok("close", {}, start);
}

async function doAction(
  action: string, args: any, meta: Message | undefined, timeout: number, start: number,
): Promise<string> {
  const s = await getSession(args, meta);
  const p = activePage(s);

  // Optional pre-wait for a selector
  if (args.waitFor && typeof args.waitFor === "string") {
    await p.waitForSelector(args.waitFor, { timeout });
  }

  switch (action) {
    /* ── navigation ── */
    case "navigate": {
      const { url } = args;
      if (!url || typeof url !== "string") throw new Error("url is required for navigate");
      assertSafeUrl(url);
      const waitUntil = args.waitUntil ?? "domcontentloaded";
      await p.goto(url, { waitUntil, timeout: Math.max(timeout, 15000) });
      const title = await p.title();
      const text = await p.innerText("body").catch(() => "");
      const snippet = text.replace(/\s+/g, " ").trim().slice(0, 3000);
      return ok("navigate", { url, title, text: snippet }, start);
    }

    /* ── screenshot ── */
    case "screenshot": {
      await fs.mkdir(OUTPUT_DIR, { recursive: true });
      const filename = `screenshot_${Date.now()}.png`;
      const filePath = path.join(OUTPUT_DIR, filename);
      const fullPage = args.fullPage === true;
      if (args.selector) {
        const el = p.locator(args.selector).first();
        await el.waitFor({ timeout });
        await el.screenshot({ path: filePath });
      } else {
        await p.screenshot({ path: filePath, fullPage });
      }
      return ok("screenshot", { path: `/output/${filename}` }, start);
    }

    /* ── click ── */
    case "click": {
      const { selector } = args;
      if (!selector) throw new Error("selector is required for click");
      await p.locator(selector).first().waitFor({ timeout });
      await p.locator(selector).first().click({ timeout });
      await p.waitForLoadState("domcontentloaded").catch(() => {});
      return ok("click", { text: selector, url: p.url() }, start);
    }

    /* ── type ── */
    case "type": {
      const { selector, text } = args;
      if (!selector) throw new Error("selector is required for type");
      if (typeof text !== "string") throw new Error("text is required for type");
      await p.locator(selector).first().waitFor({ timeout });
      await p.locator(selector).first().fill(text, { timeout });
      return ok("type", { text: `${selector} ← "${text}"` }, start);
    }

    /* ── evaluate (gated) ── */
    case "evaluate": {
      if (!args.unsafe) {
        throw new Error("evaluate requires { unsafe: true } — arbitrary JS execution is restricted by default");
      }
      const { script } = args;
      if (!script || typeof script !== "string") throw new Error("script is required for evaluate");
      const result = await p.evaluate(script);
      const output = typeof result === "string" ? result : JSON.stringify(result, null, 2);
      return ok("evaluate", { data: output }, start);
    }

    /* ── read_text ── */
    case "read_text": {
      const { selector } = args;
      if (selector) {
        await p.locator(selector).first().waitFor({ timeout });
      }
      const text = selector
        ? await p.locator(selector).first().innerText({ timeout })
        : await p.innerText("body");
      return ok("read_text", { text: text.replace(/\s+/g, " ").trim().slice(0, 15000) }, start);
    }

    /* ── get_links ── */
    case "get_links": {
      const { selector } = args;
      const scope = selector ? p.locator(selector).first() : p.locator("body");
      const anchors = scope.locator("a[href]");
      const count = await anchors.count();
      const max = 200;
      const links: { text: string; href: string }[] = [];
      for (let i = 0; i < Math.min(count, max); i++) {
        const a = anchors.nth(i);
        const href = await a.getAttribute("href").catch(() => null);
        if (!href) continue;
        const text = (await a.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
        // Resolve relative URLs to absolute
        const absolute = href.startsWith("http") ? href : new URL(href, p.url()).href;
        links.push({ text: text.slice(0, 120), href: absolute });
      }
      return ok("get_links", { links, total: count, returned: links.length }, start);
    }

    /* ── scroll ── */
    case "scroll": {
      const dir = args.direction ?? "down";
      const amount = args.amount ?? 500;
      const deltas: Record<string, [number, number]> = {
        down: [0, amount], up: [0, -amount], right: [amount, 0], left: [-amount, 0],
      };
      const [dx, dy] = deltas[dir] ?? [0, amount];
      await p.mouse.wheel(dx, dy);
      await new Promise((r) => setTimeout(r, 300)); // let scroll settle
      return ok("scroll", { text: `${dir} ${amount}px` }, start);
    }

    /* ── back / forward ── */
    case "back": {
      await p.goBack({ waitUntil: "domcontentloaded", timeout }).catch(() => {});
      return ok("back", { url: p.url(), title: await p.title() }, start);
    }
    case "forward": {
      await p.goForward({ waitUntil: "domcontentloaded", timeout }).catch(() => {});
      return ok("forward", { url: p.url(), title: await p.title() }, start);
    }

    /* ── hover ── */
    case "hover": {
      const { selector } = args;
      if (!selector) throw new Error("selector is required for hover");
      await p.locator(selector).first().waitFor({ timeout });
      await p.locator(selector).first().hover({ timeout });
      return ok("hover", { text: selector }, start);
    }

    /* ── select (dropdown) ── */
    case "select": {
      const { selector, value } = args;
      if (!selector) throw new Error("selector is required for select");
      if (!value) throw new Error("value is required for select");
      await p.locator(selector).first().waitFor({ timeout });
      await p.locator(selector).first().selectOption(value, { timeout });
      return ok("select", { text: `${selector} → ${value}` }, start);
    }

    /* ── wait ── */
    case "wait": {
      const { selector } = args;
      if (selector) {
        await p.waitForSelector(selector, { timeout });
        return ok("wait", { text: `selector found: ${selector}` }, start);
      }
      // Wait for a fixed time (capped at timeout)
      const ms = Math.min(args.amount ?? 1000, timeout);
      await new Promise((r) => setTimeout(r, ms));
      return ok("wait", { text: `waited ${ms}ms` }, start);
    }

    /* ── cookies ── */
    case "cookies": {
      const sub = args.cookieAction ?? "get";
      if (sub === "get") {
        const cookies = await s.context.cookies();
        return ok("cookies", { data: cookies }, start);
      }
      if (sub === "set") {
        const { cookie } = args;
        if (!cookie || !cookie.name || !cookie.value) throw new Error("cookie {name, value} required for set");
        let domain = cookie.domain;
        if (!domain) {
          const pageUrl = p.url();
          if (!pageUrl || pageUrl === "about:blank") {
            throw new Error("cookie domain is required when page is about:blank — navigate first or provide domain explicitly");
          }
          domain = new URL(pageUrl).hostname;
        }
        await s.context.addCookies([{
          name: cookie.name, value: cookie.value,
          domain,
          path: cookie.path ?? "/",
        }]);
        return ok("cookies", { text: `set ${cookie.name}` }, start);
      }
      if (sub === "clear") {
        await s.context.clearCookies();
        return ok("cookies", { text: "cookies cleared" }, start);
      }
      throw new Error(`Unknown cookieAction: ${sub}`);
    }

    /* ── tabs ── */
    case "open_tab": {
      const { url } = args;
      // Validate URL before creating the tab to avoid orphaned pages on failure
      if (url) assertSafeUrl(url);
      const newPage = await s.context.newPage();
      s.pages.push(newPage);
      s.activeTab = s.pages.length - 1;
      if (url) {
        await newPage.goto(url, { waitUntil: "domcontentloaded", timeout });
      }
      return ok("open_tab", { text: `tab ${s.activeTab} opened`, url: url ?? "about:blank" }, start);
    }

    case "switch_tab": {
      const idx = args.tabIndex;
      if (typeof idx !== "number" || idx < 0 || idx >= s.pages.length) {
        throw new Error(`tabIndex must be 0-${s.pages.length - 1}`);
      }
      s.activeTab = idx;
      return ok("switch_tab", { text: `switched to tab ${idx}`, url: s.pages[idx].url() }, start);
    }

    case "close_tab": {
      if (s.pages.length <= 1) throw new Error("Cannot close the last tab — use close to end the session");
      const idx = args.tabIndex ?? s.activeTab;
      if (idx < 0 || idx >= s.pages.length) throw new Error(`Invalid tabIndex: ${idx}`);
      await s.pages[idx].close();
      s.pages.splice(idx, 1);
      s.activeTab = Math.min(s.activeTab, s.pages.length - 1);
      return ok("close_tab", { text: `closed tab ${idx}, active: ${s.activeTab}` }, start);
    }

    /* ── extract (schema-based) ── */
    case "extract": {
      const { fields } = args;
      if (!fields || typeof fields !== "object") {
        throw new Error("fields object required: { fieldName: 'CSS selector', ... }");
      }
      const data: Record<string, string> = {};
      for (const [name, sel] of Object.entries(fields)) {
        if (typeof sel !== "string") continue;
        try {
          const el = p.locator(sel).first();
          await el.waitFor({ timeout: Math.min(timeout, 5000) });
          data[name] = (await el.innerText()).replace(/\s+/g, " ").trim();
        } catch {
          data[name] = "";
        }
      }
      return ok("extract", { data }, start);
    }

    default:
      throw new Error(`Unknown action: ${action}. Available: ${ALL_ACTIONS.join(", ")}`);
  }
}
