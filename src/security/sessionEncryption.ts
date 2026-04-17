/**
 * Session encryption at rest — AES-256-GCM for SQLite-stored session messages.
 *
 * Payload layout: "v1:" + base64([salt:16][iv:12][authTag:16][ciphertext])
 * The "v1:" prefix lets us distinguish ciphertext from legacy plaintext JSON
 * (which begins with "[" or "{") without ambiguity and makes future format
 * changes additive.
 *
 * When KEY_PASSPHRASE is unset, payloads round-trip as plaintext JSON so
 * dev-mode installs and tests without encryption still work.
 */

import { randomBytes, createCipheriv, createDecipheriv, scryptSync } from "crypto";
import { zeroBuffer } from "./zeroize.js";

const CIPHER_PREFIX = "v1:";
const HEADER_LEN = 16 + 12 + 16;
const keyCache = new Map<string, Buffer>();

function getPassphrase(): string | null {
  return process.env.KEY_PASSPHRASE || null;
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  const cacheKey = passphrase + ":" + salt.toString("hex");
  const cached = keyCache.get(cacheKey);
  if (cached) return cached;
  const key = scryptSync(passphrase, salt, 32);
  if (keyCache.size > 64) keyCache.clear();
  keyCache.set(cacheKey, key);
  return key;
}

/** Encrypt a JSON string. Returns a storable string (plaintext or "v1:..."). */
export function encryptPayload(json: string): string {
  const passphrase = getPassphrase();
  if (!passphrase) return json;

  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveKey(passphrase, salt);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(json, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return CIPHER_PREFIX + Buffer.concat([salt, iv, tag, data]).toString("base64");
}

/** Decrypt a payload. Transparently passes through plaintext JSON. */
export function decryptPayload(stored: string): string {
  if (!stored) return stored;
  if (!stored.startsWith(CIPHER_PREFIX)) return stored;

  const passphrase = getPassphrase();
  if (!passphrase) {
    throw new Error("Session payload is encrypted but KEY_PASSPHRASE is not set");
  }

  const buf = Buffer.from(stored.slice(CIPHER_PREFIX.length), "base64");
  if (buf.length < HEADER_LEN) throw new Error("Session payload truncated");

  const salt = buf.subarray(0, 16);
  const iv = buf.subarray(16, 28);
  const tag = buf.subarray(28, 44);
  const data = buf.subarray(44);

  const key = deriveKey(passphrase, salt);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);

  const plain = Buffer.concat([decipher.update(data), decipher.final()]);
  const json = plain.toString("utf8");
  zeroBuffer(plain);
  return json;
}

export function isSessionEncryptionEnabled(): boolean {
  return !!getPassphrase();
}
