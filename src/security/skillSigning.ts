import { generateKeyPairSync, sign, verify, createHash, KeyObject } from "crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import path from "path";

/**
 * Ed25519 Signed Skill Manifests
 *
 * Every skill package can be cryptographically signed to prove:
 * 1. Who published it (identity via public key)
 * 2. That it hasn't been tampered with (integrity via signature)
 *
 * Keypair is stored in config/signing_key.pem (private) and config/signing_key.pub (public).
 */

const CONFIG_DIR = path.join(process.cwd(), "config");
const PRIVATE_KEY_PATH = path.join(CONFIG_DIR, "signing_key.pem");
const PUBLIC_KEY_PATH = path.join(CONFIG_DIR, "signing_key.pub");

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
  if (existsSync(PRIVATE_KEY_PATH) && existsSync(PUBLIC_KEY_PATH)) {
    return {
      privateKey: readFileSync(PRIVATE_KEY_PATH, "utf8"),
      publicKey: readFileSync(PUBLIC_KEY_PATH, "utf8"),
    };
  }

  mkdirSync(CONFIG_DIR, { recursive: true });

  const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  writeFileSync(PRIVATE_KEY_PATH, privateKey, "utf8");
  writeFileSync(PUBLIC_KEY_PATH, publicKey, "utf8");
  console.log("Generated new Ed25519 signing keypair");

  return { publicKey, privateKey };
}

/** Get the instance's public key (for sharing with peers) */
export function getPublicKey(): string | null {
  if (!existsSync(PUBLIC_KEY_PATH)) return null;
  return readFileSync(PUBLIC_KEY_PATH, "utf8");
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
