/**
 * Electron main process — Option C bootstrap flow.
 *
 * First launch:
 *   1. No bootstrap blob + no vault → show setup window.
 *   2. User picks a vault passphrase. We generate API_TOKEN + COOKIE_SECRET
 *      (random 32-byte hex), seed the encrypted provider vault with a
 *      placeholder entry, and persist API_TOKEN + COOKIE_SECRET in
 *      safeStorage. Passphrase is never stored.
 *   3. Show API token once so the user can copy it for S2S access.
 *
 * Subsequent launches:
 *   1. Bootstrap blob + vault exist → show unlock window.
 *   2. User types the passphrase. We verify by attempting loadKeys().
 *   3. On success we spawn the gateway child with env:
 *        API_TOKEN / COOKIE_SECRET from keychain,
 *        KEY_PASSPHRASE from the prompt (in-memory only),
 *        HOST=127.0.0.1, NODE_ENV=production.
 *   4. Wait for /health, POST /api/auth/login programmatically, inject
 *      the resulting cookie into the main BrowserWindow's session, then
 *      load http://127.0.0.1:PORT/ui/.
 */
import { app, BrowserWindow, Menu, ipcMain, session, dialog } from "electron";
import { spawn, spawnSync, ChildProcess } from "child_process";
import { randomBytes } from "crypto";
import { existsSync, promises as fs, openSync } from "fs";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import { loadBootstrap, saveBootstrap, clearBootstrap } from "./keychain.js";
import { loadKeys, storeKey } from "../src/security/keyVault.js";
import { setupAutoUpdate } from "./autoUpdate.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;
const HOST = "127.0.0.1";

const DATA_DIR = app.isPackaged ? app.getPath("userData") : process.cwd();
const VAULT_PATH = path.join(DATA_DIR, "config", "providers.enc");
// keyVault.ts picks up DATA_DIR from env; set it before any load/store call.
process.env.DATA_DIR = DATA_DIR;

class CancelledError extends Error {
  constructor(msg: string) { super(msg); this.name = "CancelledError"; }
}

/**
 * Enforce a minimal passphrase complexity policy on first-run setup. We're
 * not trying to be NIST — we just want to keep operators from picking a
 * passphrase that would fall to a few hours of offline scrypt-guessing.
 *
 * Returns an error message to surface, or null when acceptable.
 */
function checkPassphraseStrength(pw: string): string | null {
  if (!pw || pw.length < 12) return "Passphrase must be at least 12 characters.";
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^a-zA-Z0-9]/].filter(r => r.test(pw)).length;
  if (classes < 3) return "Passphrase needs at least 3 of: lowercase, uppercase, digit, symbol.";
  if (/^(.)\1+$/.test(pw)) return "Passphrase cannot be a single repeated character.";
  if (/^(password|passphrase|12345|qwerty|letmein)/i.test(pw)) return "Passphrase is in the common-password list.";
  return null;
}

let gatewayChild: ChildProcess | null = null;
let mainWindow: BrowserWindow | null = null;
let setupWindow: BrowserWindow | null = null;
let unlockWindow: BrowserWindow | null = null;
let loadingWindow: BrowserWindow | null = null;
let booting = true;
let shuttingDown = false;
let restartCount = 0;
let restartWindowStart = Date.now();
const MAX_RESTARTS_PER_WINDOW = 5;
const RESTART_WINDOW_MS = 60_000;
let childEnv: NodeJS.ProcessEnv | null = null;

const APP_ICON = path.join(__dirname, "assets", process.platform === "win32" ? "icon.ico" : "icon.png");

function windowOpts(width: number, height: number): Electron.BrowserWindowConstructorOptions {
  return {
    width,
    height,
    icon: APP_ICON,
    resizable: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  };
}

async function showSetupWindow(): Promise<{ passphrase: string; apiToken: string; cookieSecret: string }> {
  return new Promise((resolve, reject) => {
    setupWindow = new BrowserWindow({ ...windowOpts(520, 560), title: "Wardyn — First-run setup" });
    setupWindow.loadFile(path.join(__dirname, "setup.html"));

    ipcMain.handleOnce("setup:submit", async (_evt, { passphrase }: { passphrase: string }) => {
      try {
        const weakReason = checkPassphraseStrength(passphrase);
        if (weakReason) throw new Error(weakReason);
        const apiToken = randomBytes(24).toString("hex");
        const cookieSecret = randomBytes(32).toString("hex");
        await fs.mkdir(path.dirname(VAULT_PATH), { recursive: true });
        // Seed vault: write a placeholder entry so the encrypted file exists
        // and can be round-tripped during subsequent unlock attempts.
        storeKey("_init", "ok", passphrase);
        await saveBootstrap({ apiToken, cookieSecret });
        setupWindow?.close();
        setupWindow = null;
        resolve({ passphrase, apiToken, cookieSecret });
        return { ok: true, apiToken };
      } catch (err: any) {
        return { ok: false, error: err.message };
      }
    });

    ipcMain.handleOnce("setup:cancel", () => {
      setupWindow?.close();
      setupWindow = null;
      reject(new CancelledError("Setup cancelled"));
    });

    setupWindow.on("closed", () => {
      if (setupWindow) reject(new CancelledError("Setup window closed"));
    });
  });
}

async function showUnlockWindow(): Promise<string> {
  return new Promise((resolve, reject) => {
    unlockWindow = new BrowserWindow({ ...windowOpts(420, 280), title: "Wardyn — Unlock vault" });
    unlockWindow.loadFile(path.join(__dirname, "unlock.html"));

    ipcMain.handle("unlock:submit", async (_evt, { passphrase }: { passphrase: string }) => {
      try {
        loadKeys(passphrase); // throws on wrong passphrase
        unlockWindow?.close();
        unlockWindow = null;
        ipcMain.removeHandler("unlock:submit");
        ipcMain.removeHandler("unlock:reset");
        resolve(passphrase);
        return { ok: true };
      } catch {
        return { ok: false, error: "Incorrect passphrase" };
      }
    });

    // Forgot-passphrase escape hatch. Wipes the vault + bootstrap blob and
    // relaunches into first-run setup. Provider keys, channel tokens, and
    // the API token are gone; the SQLite DB, skills, and other config
    // survive. Confirmed via a native modal dialog so an accidental click
    // can't nuke the vault.
    ipcMain.handle("unlock:reset", async () => {
      if (!unlockWindow) return { ok: false, error: "no window" };
      const choice = await dialog.showMessageBox(unlockWindow, {
        type: "warning",
        buttons: ["Cancel", "Reset vault"],
        defaultId: 0,
        cancelId: 0,
        title: "Reset vault?",
        message: "Reset the encrypted vault?",
        detail:
          "This permanently deletes the encrypted vault and the stored API token, " +
          "then restarts Wardyn into first-run setup.\n\n" +
          "LOST: every API key and channel token in the vault (OpenAI, Anthropic, " +
          "Slack, Discord, exchange creds, etc.). You will need to re-enter them.\n\n" +
          "KEPT: the SQLite database (chat history, audit logs, memory), skills, " +
          "and other configuration files.\n\n" +
          "This cannot be undone.",
      });
      if (choice.response !== 1) return { ok: false, cancelled: true };
      try {
        if (existsSync(VAULT_PATH)) await fs.unlink(VAULT_PATH);
        await clearBootstrap();
      } catch (err: any) {
        return { ok: false, error: err.message };
      }
      ipcMain.removeHandler("unlock:submit");
      ipcMain.removeHandler("unlock:reset");
      app.relaunch();
      app.exit(0);
      return { ok: true };
    });

    unlockWindow.on("closed", () => {
      ipcMain.removeHandler("unlock:submit");
      ipcMain.removeHandler("unlock:reset");
      if (unlockWindow) reject(new CancelledError("Unlock cancelled"));
    });
  });
}

function showLoadingWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 420,
    height: 520,
    title: "Wardyn",
    icon: APP_ICON,
    frame: false,
    resizable: false,
    movable: true,
    skipTaskbar: false,
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, "loading.html"));
  win.once("ready-to-show", () => win.show());
  return win;
}

function closeLoadingWindow() {
  if (loadingWindow && !loadingWindow.isDestroyed()) loadingWindow.close();
  loadingWindow = null;
}

function waitForHealth(child: ChildProcess, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      child.off("exit", onExit);
      if (err) reject(err); else resolve();
    };
    const onExit = (code: number | null) =>
      finish(new Error(`Gateway child exited before /health became ready (code=${code}). See gateway.log.`));
    child.on("exit", onExit);
    const tick = () => {
      if (done) return;
      const req = http.request(
        { host: HOST, port: PORT, path: "/health", method: "GET", timeout: 800 },
        (res) => {
          if (res.statusCode === 200) { res.resume(); finish(); return; }
          res.resume();
          retry();
        },
      );
      req.on("error", retry);
      req.on("timeout", () => { req.destroy(); retry(); });
      req.end();
    };
    const retry = () => {
      if (done) return;
      if (Date.now() - start > timeoutMs) return finish(new Error("Gateway did not become ready"));
      setTimeout(tick, 400);
    };
    tick();
  });
}

function loginAndCaptureCookies(apiToken: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ token: apiToken });
    const req = http.request(
      {
        host: HOST,
        port: PORT,
        path: "/api/auth/login",
        method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
      },
      (res) => {
        if (res.statusCode !== 200) { res.resume(); return reject(new Error(`login failed: ${res.statusCode}`)); }
        const set = res.headers["set-cookie"] || [];
        res.resume();
        resolve(Array.isArray(set) ? set : [set as unknown as string]);
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function injectCookies(setCookies: string[]): Promise<void> {
  const url = `http://${HOST}:${PORT}`;
  for (const raw of setCookies) {
    const [pair] = raw.split(";");
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    await session.defaultSession.cookies.set({
      url,
      name,
      value,
      httpOnly: raw.toLowerCase().includes("httponly"),
      sameSite: "strict",
      path: "/",
    });
  }
}

function resolveNodeBinary(): string {
  // Prefer the bundled Node binary shipped alongside the app.
  const ext = process.platform === "win32" ? "node.exe" : "node";
  const bundled = app.isPackaged
    ? path.join(process.resourcesPath, "node-runtime", ext)
    : path.join(__dirname, "node-runtime", ext);
  if (existsSync(bundled)) return bundled;

  // Fallback: system Node on PATH (dev mode convenience).
  const which = process.platform === "win32" ? "where" : "which";
  const r = spawnSync(which, ["node"], { encoding: "utf8" });
  if (r.status === 0) {
    const first = r.stdout.split(/\r?\n/).map(s => s.trim()).find(Boolean);
    if (first && existsSync(first)) return first;
  }
  throw new Error(
    "Could not locate Node.js. The bundled runtime is missing and no system `node` was found on PATH.",
  );
}

function probePort(host: string, port: number, timeoutMs = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request({ host, port, path: "/health", method: "GET", timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.end();
  });
}

function spawnGateway(env: NodeJS.ProcessEnv): ChildProcess {
  const entry = app.isPackaged
    ? path.join(process.resourcesPath, "app", "dist", "src", "Gateway.js")
    : path.resolve(process.cwd(), "dist", "src", "Gateway.js");
  if (!existsSync(entry)) {
    throw new Error(`Gateway entry not found at ${entry}. Run \`npm run build\`.`);
  }
  const nodeBin = resolveNodeBinary();
  const logPath = path.join(DATA_DIR, "gateway.log");
  const out = openSync(logPath, "a");
  const err = openSync(logPath, "a");
  console.log(`[electron] gateway stdio → ${logPath}`);
  console.log(`[electron] spawning gateway with ${nodeBin}`);
  childEnv = env;
  const child = spawn(nodeBin, [entry], {
    cwd: DATA_DIR,
    env,
    stdio: ["ignore", out, err],
  });
  child.on("exit", (code) => {
    console.error(`[electron] gateway exited (code=${code}) — see ${logPath}`);
    if (booting || shuttingDown) return;

    // Restart with backoff, guarded against crash-loops.
    const now = Date.now();
    if (now - restartWindowStart > RESTART_WINDOW_MS) {
      restartCount = 0;
      restartWindowStart = now;
    }
    restartCount++;
    if (restartCount > MAX_RESTARTS_PER_WINDOW) {
      console.error(`[electron] gateway crashed ${restartCount}x in ${RESTART_WINDOW_MS / 1000}s — giving up`);
      app.quit();
      return;
    }

    const delayMs = Math.min(10_000, 500 * 2 ** (restartCount - 1));
    console.warn(`[electron] restarting gateway in ${delayMs}ms (attempt ${restartCount})`);
    setTimeout(() => {
      if (shuttingDown || !childEnv) return;
      try {
        gatewayChild = spawnGateway(childEnv);
      } catch (err) {
        console.error(`[electron] gateway respawn failed:`, err);
        app.quit();
      }
    }, delayMs);
  });
  return child;
}

async function boot() {
  let passphrase: string;
  let apiToken: string;
  let cookieSecret: string;

  const hasVault = existsSync(VAULT_PATH);
  const bootstrap = hasVault ? await loadBootstrap() : null;

  if (!hasVault) {
    // Fresh install: choose new passphrase, seed vault + bootstrap blob.
    ({ passphrase, apiToken, cookieSecret } = await showSetupWindow());
  } else if (!bootstrap) {
    // Existing vault (migrated from env-var install) but no keychain blob:
    // verify the existing passphrase, then generate + persist new tokens.
    passphrase = await showUnlockWindow();
    apiToken = randomBytes(24).toString("hex");
    cookieSecret = randomBytes(32).toString("hex");
    await saveBootstrap({ apiToken, cookieSecret });
    console.log(`[electron] Existing vault imported. New API token: ${apiToken}`);
  } else {
    // Normal path: unlock existing vault, read persisted tokens.
    passphrase = await showUnlockWindow();
    apiToken = bootstrap.apiToken;
    cookieSecret = bootstrap.cookieSecret;
  }

  // Show a splash as soon as the passphrase is accepted; gateway spawn +
  // /health wait can take several seconds, during which the user would
  // otherwise see nothing.
  loadingWindow = showLoadingWindow();

  const APP_ROOT = app.isPackaged
    ? path.join(process.resourcesPath, "app")
    : path.resolve(process.cwd());
  // Both dev and packaged point at compiled dist/skills because skill sources
  // use `../../src/*.js` relative imports that only resolve against the
  // compiled tree. Packaged: resources/app/dist/skills sits next to
  // resources/app/dist/src so the imports resolve. Dev: `npm run electron`
  // runs `npm run build` first, so dist/skills exists.
  const SKILLS_ROOT = app.isPackaged
    ? path.join(process.resourcesPath, "app", "dist", "skills")
    : path.join(process.cwd(), "dist", "skills");

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "production",
    HOST,
    PORT: String(PORT),
    API_TOKEN: apiToken,
    COOKIE_SECRET: cookieSecret,
    KEY_PASSPHRASE: passphrase,
    DATA_DIR,
    APP_ROOT,
    SKILLS_ROOT,
  };
  if (await probePort(HOST, PORT)) {
    throw new Error(
      `Port ${PORT} on ${HOST} is already answering /health. Stop the stale process ` +
      `(likely a prior gateway) before launching the desktop app. On Windows: ` +
      `\`netstat -ano | findstr :${PORT}\` then \`taskkill /PID <pid> /F\`.`,
    );
  }

  gatewayChild = spawnGateway(env);
  console.log(`[electron] spawned gateway with API_TOKEN prefix=${apiToken.slice(0, 8)}… len=${apiToken.length}`);

  await waitForHealth(gatewayChild);
  const cookies = await loginAndCaptureCookies(apiToken);
  await injectCookies(cookies);

  // Bar stays hidden (autoHideMenuBar) but accelerators like Ctrl+Q / Cmd+Q
  // and reload/devtools still fire. Without a Menu set, the app has no way
  // to quit besides clicking the window's X.
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: "File",
      submenu: [
        { role: "quit" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
  ]));

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    title: "Wardyn",
    icon: APP_ICON,
    autoHideMenuBar: true,
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
    closeLoadingWindow();
  });
  await mainWindow.loadURL(`http://${HOST}:${PORT}/ui/hub.html`);
  booting = false;

  // Kick off auto-update after the main window is live so an update check
  // failure can't block boot. No-op in dev or when the dep is absent.
  setupAutoUpdate().catch((err) => console.warn("[electron] autoUpdate:", err));
}

app.whenReady().then(boot).catch((err) => {
  closeLoadingWindow();
  if (err instanceof CancelledError) {
    // User closed the setup/unlock window before finishing — quit silently.
    app.quit();
    return;
  }
  console.error("[electron] boot failed:", err);
  app.quit();
});

app.on("window-all-closed", () => {
  // During boot the unlock/setup window closes momentarily before the main
  // window opens — don't let that tear the app down.
  if (booting) return;
  shuttingDown = true;
  if (gatewayChild && !gatewayChild.killed) gatewayChild.kill("SIGTERM");
  app.quit();
});

app.on("before-quit", () => {
  shuttingDown = true;
  if (gatewayChild && !gatewayChild.killed) gatewayChild.kill("SIGTERM");
});
