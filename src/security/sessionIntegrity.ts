import { createHmac } from "crypto";

const HMAC_KEY = process.env.SESSION_HMAC_KEY || process.env.KEY_PASSPHRASE || "default-session-key";

export interface SignedSession {
  _hmac?: string;
  [key: string]: any;
}

/** Compute HMAC-SHA256 over the session JSON (excluding the _hmac field). */
function computeHmac(data: Record<string, any>): string {
  const copy = { ...data };
  delete copy._hmac;
  const payload = JSON.stringify(copy);
  return createHmac("sha256", HMAC_KEY).update(payload).digest("hex");
}

/** Sign a session object by adding an _hmac field. Returns the session with _hmac set. */
export function signSession<T extends Record<string, any>>(session: T): T & { _hmac: string } {
  const hmac = computeHmac(session);
  return { ...session, _hmac: hmac };
}

/** Verify the HMAC on a session object. Returns true if valid or if no _hmac (legacy session). */
export function verifySession(session: SignedSession): { valid: boolean; reason?: string } {
  if (!session._hmac) {
    // Legacy session without HMAC -- accept but flag for re-signing
    return { valid: true, reason: "legacy_unsigned" };
  }
  const expected = computeHmac(session);
  if (session._hmac === expected) {
    return { valid: true };
  }
  return { valid: false, reason: "hmac_mismatch" };
}

/**
 * Validate session structure -- checks required fields and types.
 * Returns a list of issues found (empty = valid).
 */
export function validateSessionStructure(data: any): string[] {
  const issues: string[] = [];
  if (!data || typeof data !== "object") {
    issues.push("not_an_object");
    return issues;
  }
  if (typeof data.id !== "string" || data.id.length === 0) issues.push("missing_id");
  if (typeof data.userId !== "string") issues.push("missing_userId");
  if (!Array.isArray(data.messages)) issues.push("messages_not_array");
  if (typeof data.createdAt !== "number") issues.push("missing_createdAt");
  if (typeof data.updatedAt !== "number") issues.push("missing_updatedAt");

  // Validate each message has required fields
  if (Array.isArray(data.messages)) {
    for (let i = 0; i < data.messages.length; i++) {
      const msg = data.messages[i];
      if (!msg || typeof msg !== "object") {
        issues.push(`message[${i}]_invalid`);
        continue;
      }
      if (!["user", "assistant", "tool", "system"].includes(msg.role)) {
        issues.push(`message[${i}]_bad_role`);
      }
    }
  }
  return issues;
}

/**
 * Attempt to repair a corrupted session.
 * - Removes invalid messages
 * - Fixes missing fields with defaults
 * - Returns repaired session or null if unrecoverable
 */
export function repairSession(data: any, sessionId: string): Record<string, any> | null {
  if (!data || typeof data !== "object") return null;

  const repaired: Record<string, any> = {
    id: typeof data.id === "string" ? data.id : sessionId,
    userId: typeof data.userId === "string" ? data.userId : "unknown",
    summary: typeof data.summary === "string" ? data.summary : "",
    messages: [],
    createdAt: typeof data.createdAt === "number" ? data.createdAt : Date.now(),
    updatedAt: Date.now(),
  };

  // Salvage valid messages
  if (Array.isArray(data.messages)) {
    for (const msg of data.messages) {
      if (!msg || typeof msg !== "object") continue;
      if (!["user", "assistant", "tool", "system"].includes(msg.role)) continue;
      repaired.messages.push({
        role: msg.role,
        content: msg.content ?? null,
        ts: typeof msg.ts === "number" ? msg.ts : Date.now(),
        ...(msg.tool_calls ? { tool_calls: msg.tool_calls } : {}),
        ...(msg.tool_call_id ? { tool_call_id: msg.tool_call_id } : {}),
      });
    }
  }

  return repaired;
}
