import { URL } from "url";
import dns from "dns/promises";
import net from "net";
import type { LookupFunction } from "net";

/**
 * SSRF Guard — blocks outbound requests to private IPs, cloud metadata,
 * and DNS rebinding attacks.
 */

// Private / reserved IPv4 ranges (CIDR)
const PRIVATE_RANGES_V4: [number, number, number][] = [
  // [network as 32-bit int, mask bits, ...]
  // We'll use start/end for clarity
];

function ipToInt(ip: string): number {
  const parts = ip.split(".").map(Number);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

const BLOCKED_V4_RANGES: { start: number; end: number; label: string }[] = [
  { start: ipToInt("0.0.0.0"), end: ipToInt("0.255.255.255"), label: "this-network" },
  { start: ipToInt("10.0.0.0"), end: ipToInt("10.255.255.255"), label: "private-10" },
  { start: ipToInt("100.64.0.0"), end: ipToInt("100.127.255.255"), label: "shared-address" },
  { start: ipToInt("127.0.0.0"), end: ipToInt("127.255.255.255"), label: "loopback" },
  { start: ipToInt("169.254.0.0"), end: ipToInt("169.254.255.255"), label: "link-local" },
  { start: ipToInt("172.16.0.0"), end: ipToInt("172.31.255.255"), label: "private-172" },
  { start: ipToInt("192.0.0.0"), end: ipToInt("192.0.0.255"), label: "ietf-protocol" },
  { start: ipToInt("192.168.0.0"), end: ipToInt("192.168.255.255"), label: "private-192" },
  { start: ipToInt("198.18.0.0"), end: ipToInt("198.19.255.255"), label: "benchmark" },
  { start: ipToInt("224.0.0.0"), end: ipToInt("239.255.255.255"), label: "multicast" },
  { start: ipToInt("240.0.0.0"), end: ipToInt("255.255.255.255"), label: "reserved" },
];

function isPrivateIPv4(ip: string): string | null {
  const n = ipToInt(ip);
  for (const range of BLOCKED_V4_RANGES) {
    if (n >= range.start && n <= range.end) return range.label;
  }
  return null;
}

function isPrivateIPv6(ip: string): string | null {
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::") return "loopback-v6";
  if (lower.startsWith("fe80:")) return "link-local-v6";
  if (lower.startsWith("fc") || lower.startsWith("fd")) return "unique-local-v6";
  // IPv4-mapped IPv6 — ::ffff:x.x.x.x
  if (lower.startsWith("::ffff:")) {
    const v4 = lower.slice(7);
    if (net.isIPv4(v4)) return isPrivateIPv4(v4);
  }
  return null;
}

function isPrivateIP(ip: string): string | null {
  if (net.isIPv4(ip)) return isPrivateIPv4(ip);
  if (net.isIPv6(ip)) return isPrivateIPv6(ip);
  return null;
}

// Cloud metadata endpoints (hostname patterns)
const CLOUD_METADATA_HOSTS = [
  "169.254.169.254",       // AWS, GCP, Azure IMDS
  "metadata.google.internal",
  "metadata.goog",
  "100.100.100.200",       // Alibaba Cloud
  "169.254.170.2",         // AWS ECS task metadata
];

// Blocked URL schemes
const BLOCKED_SCHEMES = new Set(["file:", "ftp:", "gopher:", "data:", "dict:", "ldap:", "tftp:"]);

export interface SSRFCheckResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Validate a URL before making an outbound request.
 * Checks: scheme, hostname, DNS resolution to private IP, cloud metadata endpoints.
 */
export async function checkSSRF(rawUrl: string): Promise<SSRFCheckResult> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { allowed: false, reason: "Invalid URL" };
  }

  // Block dangerous schemes
  if (BLOCKED_SCHEMES.has(parsed.protocol)) {
    return { allowed: false, reason: `Blocked scheme: ${parsed.protocol}` };
  }

  // Only allow http/https
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { allowed: false, reason: `Unsupported scheme: ${parsed.protocol}` };
  }

  const hostname = parsed.hostname.toLowerCase();

  // Block cloud metadata hostnames
  if (CLOUD_METADATA_HOSTS.includes(hostname)) {
    return { allowed: false, reason: `Blocked cloud metadata endpoint: ${hostname}` };
  }

  // If hostname is already an IP, check directly
  if (net.isIP(hostname)) {
    const label = isPrivateIP(hostname);
    if (label) return { allowed: false, reason: `Blocked private IP (${label}): ${hostname}` };
    return { allowed: true };
  }

  // DNS resolution check (anti-rebinding: resolve before request)
  try {
    const addresses = await dns.resolve4(hostname).catch(() => [] as string[]);
    const addresses6 = await dns.resolve6(hostname).catch(() => [] as string[]);
    const all = [...addresses, ...addresses6];

    if (all.length === 0) {
      return { allowed: false, reason: `DNS resolution failed for: ${hostname}` };
    }

    for (const ip of all) {
      const label = isPrivateIP(ip);
      if (label) {
        return { allowed: false, reason: `DNS rebinding blocked: ${hostname} resolves to private IP ${ip} (${label})` };
      }
    }
  } catch (err: any) {
    return { allowed: false, reason: `DNS check failed for ${hostname}: ${err.message}` };
  }

  return { allowed: true };
}

/**
 * Synchronous fast-path check (no DNS resolution, just scheme + hostname).
 * Use for quick filtering; use checkSSRF() for full validation.
 */
export function quickSSRFCheck(rawUrl: string): SSRFCheckResult {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { allowed: false, reason: "Invalid URL" };
  }

  if (BLOCKED_SCHEMES.has(parsed.protocol)) {
    return { allowed: false, reason: `Blocked scheme: ${parsed.protocol}` };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { allowed: false, reason: `Unsupported scheme: ${parsed.protocol}` };
  }

  const hostname = parsed.hostname.toLowerCase();
  if (CLOUD_METADATA_HOSTS.includes(hostname)) {
    return { allowed: false, reason: `Blocked cloud metadata endpoint: ${hostname}` };
  }

  if (net.isIP(hostname)) {
    const label = isPrivateIP(hostname);
    if (label) return { allowed: false, reason: `Blocked private IP (${label}): ${hostname}` };
  }

  return { allowed: true };
}

/**
 * Build a `lookup`-compatible function that validates every address returned
 * by the resolver and refuses private ranges. Use this when handing the URL
 * to `http.request`/`https.request`/`fetch` so the same address checked by
 * `checkSSRF` is the one the socket actually connects to.
 *
 * This closes the TOCTOU window between DNS pre-flight and connect.
 */
export function safeLookup(): LookupFunction {
  return ((hostname, options, cb) => {
    const callback = typeof options === "function" ? options : cb;
    const opts = typeof options === "function" ? {} : (options ?? {});
    // Resolve both families, then filter private before handing one back.
    Promise.all([
      dns.resolve4(hostname).catch(() => [] as string[]),
      dns.resolve6(hostname).catch(() => [] as string[]),
    ]).then(([v4, v6]) => {
      const candidates: { address: string; family: number }[] = [
        ...v4.map(a => ({ address: a, family: 4 })),
        ...v6.map(a => ({ address: a, family: 6 })),
      ];
      const safe = candidates.filter(c => !isPrivateIP(c.address));
      if (safe.length === 0) {
        (callback as any)(new Error(`SSRF block: ${hostname} has no public addresses`));
        return;
      }
      const all = (opts as any).all;
      if (all) (callback as any)(null, safe);
      else (callback as any)(null, safe[0].address, safe[0].family);
    }).catch((err) => {
      (callback as any)(err);
    });
  }) as LookupFunction;
}
