import { generateKeyPairSync, sign, verify, createHash, KeyObject } from "crypto";
import { readFileSync, existsSync, unlinkSync } from "fs";
import path from "path";
import { loadKeys, storeKey } from "./keyVault.js";

/**
 * Ed25519 Signed Skill Manifests
 *
 * Every skill package can be cryptographically signed to prove:
 * 1. Who published it (identity via public key)
 * 2. That it hasn't been tampered with (integrity via signature)
 *
 * Keypair lives in the encrypted provider vault under reserved keys
 * (`_signing:private`, `_signing:public`) — same AES-256-GCM + scrypt
 * protection as provider API keys, gated by KEY_PASSPHRASE.
 *
 * Pre-vault installs stored PEMs at config/signing_key.pem(.pub); on first
 * call after upgrade those files are imported into the vault and deleted.
 */

const CONFIG_DIR = path.join(process.cwd(), "config");
const LEGACY_PRIVATE_PATH = path.join(CONFIG_DIR, "signing_key.pem");
const LEGACY_PUBLIC_PATH = path.join(CONFIG_DIR, "signing_key.pub");
const VAULT_PRIVATE_KEY = "_signing:private";
const VAULT_PUBLIC_KEY = "_signing:public";

function getPassphrase(): string {
  const p = process.env.KEY_PASSPHRASE;
  if (!p) throw new Error("KEY_PASSPHRASE required to access the signing keypair");
  return p;
}

function migrateLegacyPemsIfPresent(passphrase: string): void {
  if (!existsSync(LEGACY_PRIVATE_PATH) || !existsSync(LEGACY_PUBLIC_PATH)) return;
  const priv = readFileSync(LEGACY_PRIVATE_PATH, "utf8");
  const pub = readFileSync(LEGACY_PUBLIC_PATH, "utf8");
  storeKey(VAULT_PRIVATE_KEY, priv, passphrase);
  storeKey(VAULT_PUBLIC_KEY, pub, passphrase);
  try { unlinkSync(LEGACY_PRIVATE_PATH); } catch {}
  try { unlinkSync(LEGACY_PUBLIC_PATH); } catch {}
  console.log("Migrated legacy signing keypair from disk to encrypted vault");
}

export interface SkillManifest {
  name: string;
  version: string;
  language: string;
  codeHash: string;      // SHA-256 of the skill code
  author: string;
  timestamp: string;      // ISO 8601
  capabilities?: string[]; // declared tool capabilities
}

export interface SignedManifest {
  manifest: SkillManifest;
  signature: string;      // hex-encoded Ed25519 signature
  publicKey: string;      // PEM public key of the signer
}

/** Generate a new Ed25519 keypair if one doesn't exist */
export function ensureKeypair(): { publicKey: string; privateKey: string } {
  const passphrase = getPassphrase();
  migrateLegacyPemsIfPresent(passphrase);

  let vault: Record<string, string>;
  try {
    vault = loadKeys(passphrase);
  } catch {
    vault = {};
  }

  const existingPriv = vault[VAULT_PRIVATE_KEY];
  const existingPub = vault[VAULT_PUBLIC_KEY];
  if (existingPriv && existingPub) {
    return { privateKey: existingPriv, publicKey: existingPub };
  }

  const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  storeKey(VAULT_PRIVATE_KEY, privateKey, passphrase);
  storeKey(VAULT_PUBLIC_KEY, publicKey, passphrase);
  console.log("Generated new Ed25519 signing keypair (stored in vault)");

  return { publicKey, privateKey };
}

/** Get the instance's public key (for sharing with peers) */
export function getPublicKey(): string | null {
  try {
    const vault = loadKeys(getPassphrase());
    return vault[VAULT_PUBLIC_KEY] ?? null;
  } catch {
    return null;
  }
}

/** Compute SHA-256 hash of skill code */
function codeHash(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

/** Canonical JSON representation of a manifest (deterministic for signing) */
function canonicalize(manifest: SkillManifest): string {
  return JSON.stringify(manifest, Object.keys(manifest).sort());
}

/** Sign a skill manifest with the instance's private key */
export function signManifest(manifest: SkillManifest): SignedManifest {
  const keys = ensureKeypair();
  const data = Buffer.from(canonicalize(manifest), "utf8");
  const signature = sign(null, data, keys.privateKey);

  return {
    manifest,
    signature: signature.toString("hex"),
    publicKey: keys.publicKey,
  };
}

/** Create and sign a manifest for a skill */
export function createSignedManifest(
  name: string,
  version: string,
  language: string,
  code: string,
  author: string,
  capabilities?: string[]
): SignedManifest {
  const manifest: SkillManifest = {
    name,
    version,
    language,
    codeHash: codeHash(code),
    author,
    timestamp: new Date().toISOString(),
    capabilities,
  };
  return signManifest(manifest);
}

/** Verify a signed manifest against its embedded public key */
export function verifyManifest(signed: SignedManifest): {
  valid: boolean;
  reason?: string;
} {
  try {
    const data = Buffer.from(canonicalize(signed.manifest), "utf8");
    const sig = Buffer.from(signed.signature, "hex");
    const isValid = verify(null, data, signed.publicKey, sig);

    if (!isValid) {
      return { valid: false, reason: "Signature verification failed -- manifest may be tampered" };
    }

    return { valid: true };
  } catch (err: any) {
    return { valid: false, reason: `Verification error: ${err.message}` };
  }
}

/** Verify that a signed manifest matches the actual skill code */
export function verifySkillCode(signed: SignedManifest, code: string): {
  valid: boolean;
  reason?: string;
} {
  const sigResult = verifyManifest(signed);
  if (!sigResult.valid) return sigResult;

  const actual = codeHash(code);
  if (actual !== signed.manifest.codeHash) {
    return {
      valid: false,
      reason: `Code hash mismatch: expected ${signed.manifest.codeHash.slice(0, 12)}..., got ${actual.slice(0, 12)}...`,
    };
  }

  return { valid: true };
}

/** Verify a manifest against a trusted public key (not just the embedded one) */
export function verifyWithTrustedKey(signed: SignedManifest, trustedPubKey: string): {
  valid: boolean;
  reason?: string;
} {
  // Check that the embedded key matches the trusted key
  if (signed.publicKey.trim() !== trustedPubKey.trim()) {
    return { valid: false, reason: "Public key does not match trusted key" };
  }
  return verifyManifest(signed);
}
