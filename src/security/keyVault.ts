import { randomBytes, createCipheriv, createDecipheriv, scryptSync } from "crypto";
import { readFileSync, writeFileSync, existsSync } from "fs";
import path from "path";
import { zeroBuffer } from "./zeroize.js";
import { paths } from "../paths.js";
function vaultPath(): string {
  return paths.config("providers.enc");
}
const VAULT_PATH_LEGACY = path.join(process.cwd(), "config", "providers.enc");
export function storeKey(name: string, value: string, passphrase: string) {
  const p = vaultPath();
  // Merge with existing vault if present
  let existing: Record<string, string> = {};
  if (existsSync(p)) {
    try {
      existing = loadKeys(passphrase);
    } catch (err) {
      throw new Error("Failed to decrypt existing vault with provided passphrase");
    }
  }
  const payload = { ...existing, [name]: value };
  const salt = randomBytes(16); const key = scryptSync(passphrase, salt, 32);
  const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  writeFileSync(p, Buffer.concat([salt, iv, tag, data]));
}
export function loadKeys(passphrase: string): Record<string, string> {
  const p = vaultPath();
  const buf = readFileSync(existsSync(p) ? p : VAULT_PATH_LEGACY);
  const salt = buf.subarray(0,16), iv = buf.subarray(16,28), tag = buf.subarray(28,44), data = buf.subarray(44);
  const derivedKey = scryptSync(passphrase, salt, 32);
  const decipher = createDecipheriv("aes-256-gcm", derivedKey, iv);
  decipher.setAuthTag(tag);
  const plainBuf = Buffer.concat([decipher.update(data), decipher.final()]);
  const json = plainBuf.toString("utf8");
  const result = JSON.parse(json);
  // Wipe sensitive buffers from memory
  zeroBuffer(plainBuf);
  zeroBuffer(derivedKey as Buffer);
  return result;
}
