/**
 * Keychain wrapper for Electron main process.
 *
 * Stores bootstrap tokens (API_TOKEN, COOKIE_SECRET) encrypted via
 * Electron's safeStorage on disk under the app's userData dir.
 *
 * safeStorage ties the encryption key to the current OS user session
 * (DPAPI on Windows, Keychain on macOS, kwallet/gnome-keyring on Linux).
 * An attacker without the user's OS login cannot decrypt the blob
 * offline. Attackers running as the same OS user can — which is fine:
 * the *vault passphrase* (protecting provider keys) is NOT stored here.
 * That is Option C's tradeoff.
 */
import { app, safeStorage } from "electron";
import { promises as fs, existsSync } from "fs";
import path from "path";

interface Bootstrap {
  apiToken: string;
  cookieSecret: string;
}

function blobPath(): string {
  return path.join(app.getPath("userData"), "bootstrap.bin");
}

export async function loadBootstrap(): Promise<Bootstrap | null> {
  const p = blobPath();
  if (!existsSync(p)) return null;
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("OS keychain/safeStorage is not available on this system");
  }
  const buf = await fs.readFile(p);
  const json = safeStorage.decryptString(buf);
  return JSON.parse(json) as Bootstrap;
}

export async function saveBootstrap(b: Bootstrap): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("OS keychain/safeStorage is not available on this system");
  }
  const enc = safeStorage.encryptString(JSON.stringify(b));
  const p = blobPath();
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, enc, { mode: 0o600 });
}

export async function clearBootstrap(): Promise<void> {
  const p = blobPath();
  if (existsSync(p)) await fs.unlink(p);
}
