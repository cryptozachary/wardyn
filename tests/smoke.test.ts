/**
 * Production smoke test: boots the compiled server against a random port
 * and verifies the security contract end-to-end.
 *
 * Run (after build): npx tsx tests/smoke.test.ts
 */

import http from "http";
import { spawn, type ChildProcess } from "child_process";
import path from "path";
import fs from "fs";

const PORT = Number(process.env.SMOKE_PORT) || 18085;
const TOKEN = "smoke-token-0123456789abcdef";
const KEY_PASSPHRASE = "smoke";
const COOKIE_SECRET = "smoke-cookie-secret-0123456789abcdef";

async function req(method: string, p: string, opts: { headers?: Record<string, string>; body?: any } = {}): Promise<{ status: number; body: any }> {
  const data = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  return new Promise((resolve, reject) => {
    const r = http.request({
      host: "127.0.0.1", port: PORT, method, path: p,
      headers: {
        "content-type": "application/json",
        ...(data ? { "content-length": String(Buffer.byteLength(data)) } : {}),
        ...(opts.headers || {}),
      },
    }, (res) => {
      let buf = "";
      res.on("data", c => buf += c);
      res.on("end", () => {
        let parsed: any = buf;
        try { parsed = JSON.parse(buf); } catch {}
        resolve({ status: res.statusCode || 0, body: parsed });
      });
    });
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}

async function waitForReady(child: ChildProcess, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await req("GET", "/health");
      if (r.status === 200) return;
    } catch {}
    await new Promise(res => setTimeout(res, 400));
  }
  throw new Error("server did not become ready in time");
}

async function run() {
  const entry = path.resolve("dist/src/Gateway.js");
  if (!fs.existsSync(entry)) {
    console.error(`smoke: compiled entry not found at ${entry}. Run "npm run build" first.`);
    process.exit(2);
  }

  console.log(`smoke: booting server at :${PORT}`);
  const env = {
    ...process.env,
    PORT: String(PORT),
    API_TOKEN: TOKEN,
    COOKIE_SECRET,
    KEY_PASSPHRASE,
    NODE_ENV: "production",
    LOG_LEVEL: "warn",
    ENABLE_HSTS: "true",
  };
  const child = spawn(process.execPath, [entry], { env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout?.on("data", d => process.stdout.write(d));
  child.stderr?.on("data", d => process.stderr.write(d));

  let exited = false;
  child.on("exit", () => { exited = true; });

  try {
    await waitForReady(child);
    const failures: string[] = [];

    const check = (name: string, ok: boolean, detail = "") => {
      if (ok) console.log(`  PASS  ${name}`);
      else { console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`); failures.push(name); }
    };

    // 1. health is reachable without auth
    const health = await req("GET", "/health");
    check("/health public ok", health.status === 200 && health.body?.ok === true, `status=${health.status}`);

    // 2. /api/* requires auth
    const apiNoAuth = await req("GET", "/api/setup/status");
    check("/api/setup/status 401 without token", apiNoAuth.status === 401);

    // 3. /api/* works with token
    const apiOk = await req("GET", "/api/setup/status", { headers: { "x-api-token": TOKEN } });
    check("/api/setup/status 200 with token", apiOk.status === 200);

    // 4. /ui redirects unauth to /login
    const ui = await req("GET", "/ui/", { headers: { accept: "text/html" } });
    check("/ui/ unauthenticated redirected or 401", ui.status === 302 || ui.status === 401);

    // 5. login flow
    const login = await req("POST", "/api/auth/login", { body: { token: TOKEN } });
    check("/api/auth/login 200", login.status === 200);

    // 6. login rejection
    const badLogin = await req("POST", "/api/auth/login", { body: { token: "bad" } });
    check("/api/auth/login 401 for bad token", badLogin.status === 401);

    // 7. missing telegram secret
    const tg = await req("POST", "/webhook/telegram", { body: { update_id: 1 } });
    check("/webhook/telegram refuses without secret env", tg.status === 503);

    // 8. discord webhook with no public key -> 404
    const dc = await req("POST", "/webhook/discord", { body: {} });
    check("/webhook/discord 404 without public key", dc.status === 404);

    // 9. slack with no secret -> 503
    const sl = await req("POST", "/webhook/slack", { body: { type: "event_callback" } });
    check("/webhook/slack refuses without signing secret", sl.status === 503);

    // 10. HSTS present
    const hstsProbe = await new Promise<string | undefined>((resolve) => {
      const r = http.request({ host: "127.0.0.1", port: PORT, method: "GET", path: "/health" }, res => {
        resolve(res.headers["strict-transport-security"] as string | undefined);
        res.resume();
      });
      r.on("error", () => resolve(undefined));
      r.end();
    });
    check("HSTS header present in prod", !!hstsProbe, `value=${hstsProbe}`);

    if (failures.length > 0) {
      console.log(`\n${failures.length} smoke failure(s)`);
      process.exitCode = 1;
    } else {
      console.log("\nall smoke checks passed");
    }
  } catch (err: any) {
    console.error("smoke: error —", err.message);
    process.exitCode = 1;
  } finally {
    if (!exited) {
      child.kill("SIGTERM");
      await new Promise(res => setTimeout(res, 1200));
      if (!exited) child.kill("SIGKILL");
    }
  }
}

run();
