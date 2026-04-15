#!/usr/bin/env tsx
/**
 * myclaw pair — manage DM pairings.
 *
 * Usage:
 *   npm run pair -- list
 *   npm run pair -- approve <code>
 *   npm run pair -- approve <channel> <externalId>
 *   npm run pair -- revoke <channel> <externalId>
 */
import { approveByCode, approve, revoke, listPairings, type Channel } from "../src/security/pairingGuard.js";

const VALID: Channel[] = ["telegram", "discord", "slack", "whatsapp"];

function usage(): never {
  console.error([
    "usage:",
    "  pair list",
    "  pair approve <code>",
    "  pair approve <channel> <externalId>",
    "  pair revoke  <channel> <externalId>",
  ].join("\n"));
  process.exit(2);
}

const [cmd, a, b] = process.argv.slice(2);

if (cmd === "list") {
  const pairs = listPairings();
  if (pairs.length === 0) { console.log("(no pairings)"); process.exit(0); }
  for (const p of pairs) {
    const status = p.approvedAt ? "APPROVED" : `PENDING code=${p.code}`;
    const last = new Date(p.lastSeenAt).toISOString();
    console.log(`  ${p.channel.padEnd(9)} ${p.externalId.padEnd(30)} ${status.padEnd(26)} last=${last}`);
  }
} else if (cmd === "approve") {
  if (a && !b) {
    const p = approveByCode(a);
    if (!p) { console.error("code not found or already approved"); process.exit(1); }
    console.log(`approved ${p.channel}:${p.externalId}`);
  } else if (a && b) {
    if (!VALID.includes(a as Channel)) { console.error(`unknown channel: ${a}`); process.exit(2); }
    const p = approve(a as Channel, b);
    console.log(`approved ${p.channel}:${p.externalId}`);
  } else usage();
} else if (cmd === "revoke") {
  if (!a || !b) usage();
  if (!VALID.includes(a as Channel)) { console.error(`unknown channel: ${a}`); process.exit(2); }
  const ok = revoke(a as Channel, b);
  console.log(ok ? "revoked" : "not found");
} else {
  usage();
}
