/**
 * Session encryption at rest — AES-256-GCM encryption for session files.
 *
 * Uses KEY_PASSPHRASE (same as vault) to derive an encryption key.
 * Each session file gets a unique salt + IV so identical sessions produce
 * different ciphertext.
 *
 * File format: [salt:16][iv:12][authTag:16][ciphertext:...]
 * Same layout as keyVault.ts for consistency.
 *
 * When KEY_PASSPHRASE is not set, sessions are stored as plaintext JSON
 * (backwards compatible — no encryption without a passphrase).
 */

import { randomBytes, createCipheriv, createDecipheriv, scryptSync } from "crypto";
import { zeroBuffer } from "./zeroize.js";

const HEADER_LEN = 16 + 12 + 16; // salt + iv + tag

function getPassphrase(): string | null {
  return process.env.KEY_PASSPHRASE || null;
}

/**
 * Encrypt a session JSON string. Returns a Buffer ready to write to disk.
 * If no passphrase is configured, returns the plain JSON as a Buffer.
 */
export function encryptSession(json: string): Buffer {
  const passphrase = getPassphrase();
  if (!passphrase) return Buffer.from(json, "utf8");

  const salt = randomBytes(16);
  const key = scryptSync(passphrase, salt, 32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(json, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  // Wipe key from memory
  zeroBuffer(key as Buffer);

  return Buffer.concat([salt, iv, tag, data]);
}

/**
 * Decrypt a session file buffer back to JSON string.
 * Auto-detects plaintext vs encrypted (plaintext starts with '{').
 */
export function decryptSession(buf: Buffer): string {
  // Auto-detect: plaintext JSON starts with '{' (0x7B)
  if (buf.length > 0 && buf[0] === 0x7B) {
    return buf.toString("utf8");
  }

  const passphrase = getPassphrase();
  if (!passphrase) {
    // File is encrypted but no passphrase — try reading as plaintext anyway
    const text = buf.toString("utf8");
    try {
      JSON.parse(text);
      return text; // Valid JSON, wasn't encrypted
    } catch {
      throw new Error("Session file appears encrypted but KEY_PASSPHRASE is not set");
    }
  }

  if (buf.length < HEADER_LEN) {
    throw new Error("Session file too short to be encrypted");
  }

  const salt = buf.subarray(0, 16);
  const iv = buf.subarray(16, 28);
  const tag = buf.subarray(28, 44);
  const data = buf.subarray(44);

  const key = scryptSync(passphrase, salt, 32);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);

  const plainBuf = Buffer.concat([decipher.update(data), decipher.final()]);
  const json = plainBuf.toString("utf8");

  // Wipe sensitive buffers
  zeroBuffer(plainBuf);
  zeroBuffer(key as Buffer);

  return json;
}

/**
 * Check if session encryption is available (passphrase configured).
 */
export function isSessionEncryptionEnabled(): boolean {
  return !!getPassphrase();
}
