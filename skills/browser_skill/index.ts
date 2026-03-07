import { chromium, Browser, Page } from "playwright";
import { promises as fs } from "fs";
import path from "path";

export const parameters = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["navigate", "screenshot", "click", "type", "evaluate", "read_text", "close"],
      description: "The browser action to perform"
    },
    url: { type: "string", description: "URL to navigate to (required for 'navigate')" },
    selector: { type: "string", description: "CSS selector (required for 'click' and 'type', optional for 'screenshot' and 'read_text')" },
    text: { type: "string", description: "Text to type (required for 'type')" },
    script: { type: "string", description: "JavaScript to evaluate (required for 'evaluate')" }
  },
  required: ["action"]
};

const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const SCREENSHOT_DIR = path.join(process.cwd(), "sandbox", "screenshots");

let browser: Browser | null = null;
let page: Page | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

async function ensureBrowser(): Promise<Page> {
  resetIdleTimer();
  if (browser && page) return page;
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  });
  page = await context.newPage();
  // Block common resource-heavy content to keep it fast
  await page.route("**/*.{png,jpg,jpeg,gif,svg,webp,woff,woff2,ttf,eot}", (route) =>
    route.abort()
  );
  return page;
}

function resetIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => closeBrowser(), IDLE_TIMEOUT_MS);
}

async function closeBrowser(): Promise<string> {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  if (browser) {
    await browser.close().catch(() => {});
    browser = null;
    page = null;
  }
  return "Browser closed.";
}

export async function execute(args: any): Promise<string> {
  const { action } = args;
  if (!action || typeof action !== "string") {
    throw new Error("action is required (navigate|screenshot|click|type|evaluate|read_text|close)");
  }

  if (action === "close") {
    return closeBrowser();
  }

  const p = await ensureBrowser();

  switch (action) {
    case "navigate": {
      const { url } = args;
      if (!url || typeof url !== "string") throw new Error("url is required for navigate");
      if (!/^https?:\/\//i.test(url)) throw new Error("url must start with http:// or https://");
      await p.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
      const title = await p.title();
      const text = await p.innerText("body").catch(() => "");
      const snippet = text.replace(/\s+/g, " ").trim().slice(0, 1000);
      return `Navigated to: ${url}\nTitle: ${title}\nContent preview: ${snippet}`;
    }

    case "screenshot": {
      await fs.mkdir(SCREENSHOT_DIR, { recursive: true });
      const filename = `screenshot_${Date.now()}.png`;
      const filePath = path.join(SCREENSHOT_DIR, filename);
      if (args.selector) {
        const el = p.locator(args.selector).first();
        await el.screenshot({ path: filePath });
      } else {
        await p.screenshot({ path: filePath, fullPage: false });
      }
      return `Screenshot saved: sandbox/screenshots/${filename}`;
    }

    case "click": {
      const { selector } = args;
      if (!selector) throw new Error("selector is required for click");
      await p.locator(selector).first().click({ timeout: 5000 });
      await p.waitForLoadState("domcontentloaded").catch(() => {});
      return `Clicked: ${selector}`;
    }

    case "type": {
      const { selector, text } = args;
      if (!selector) throw new Error("selector is required for type");
      if (typeof text !== "string") throw new Error("text is required for type");
      await p.locator(selector).first().fill(text, { timeout: 5000 });
      return `Typed into ${selector}: "${text}"`;
    }

    case "evaluate": {
      const { script } = args;
      if (!script || typeof script !== "string") throw new Error("script is required for evaluate");
      const result = await p.evaluate(script);
      return typeof result === "string" ? result : JSON.stringify(result, null, 2);
    }

    case "read_text": {
      const { selector } = args;
      const text = selector
        ? await p.locator(selector).first().innerText({ timeout: 5000 })
        : await p.innerText("body");
      return text.replace(/\s+/g, " ").trim().slice(0, 3000);
    }

    default:
      throw new Error(`Unknown action: ${action}. Use: navigate, screenshot, click, type, evaluate, read_text, close`);
  }
}
