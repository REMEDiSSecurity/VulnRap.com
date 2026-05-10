// Task #1310 — SSRF guard used by webhook registration / delivery.
//
// Reviewer-supplied destination URLs must not target the host's own
// loopback, RFC1918 internal ranges, link-local, or cloud metadata
// endpoints — otherwise a malicious or curious reviewer could trick the
// server into POSTing the signed report payload to an internal service
// (e.g. http://169.254.169.254/latest/meta-data/iam/security-credentials).
//
// The guard works at two levels:
//
//   1. The hostname itself: literal IP addresses (v4 + v6) and known
//      special hostnames (localhost, *.localhost, metadata.google.internal)
//      are rejected before any DNS lookup.
//   2. DNS resolution: every A/AAAA record returned for the hostname is
//      checked against the same blocked-range table so that a public
//      hostname that resolves to a private IP is also caught.
//
// The DNS check is opt-in via the `resolve` callback so callers can
// inject a stub in tests. When `resolve` is not supplied the guard
// performs the textual / literal-IP checks only (which still cover the
// common attacker-controlled-input case where the URL contains a
// raw private IP).

import { isIP, isIPv4 } from "node:net";

export interface PrivateHostGuardResult {
  ok: boolean;
  reason?: string;
  /** Resolved IP addresses that triggered the rejection, if any. */
  blockedIps?: string[];
  /**
   * The full set of validated IP addresses for the host, populated when
   * `ok === true` and a `resolve` callback was supplied. Callers that
   * need to **pin** a connection to one of these addresses (so a
   * second DNS lookup at connect-time can't return a different value —
   * the DNS-rebinding TOCTOU window) should pick from this list rather
   * than re-resolving. For literal-IP hosts the single literal is
   * returned. Empty when no DNS lookup was performed (literal-IP path
   * or `resolve` not supplied).
   */
  addresses?: string[];
}

const BLOCKED_HOSTNAMES = new Set<string>([
  "localhost",
  "ip6-localhost",
  "ip6-loopback",
  // GCE / GKE
  "metadata.google.internal",
  "metadata",
]);

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const n = Number(part);
    if (n < 0 || n > 255) return null;
    result = result * 256 + n;
  }
  return result >>> 0;
}

function inCidr(ip: number, cidr: [string, number]): boolean {
  const [base, bits] = cidr;
  const baseInt = ipv4ToInt(base);
  if (baseInt === null) return false;
  if (bits === 0) return true;
  const mask = bits === 32 ? 0xffffffff : (~((1 << (32 - bits)) - 1)) >>> 0;
  return (ip & mask) === (baseInt & mask);
}

const BLOCKED_V4_CIDRS: [string, number][] = [
  ["0.0.0.0", 8], // "this" network
  ["10.0.0.0", 8], // RFC1918
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local + AWS/GCP IMDS (169.254.169.254)
  ["172.16.0.0", 12], // RFC1918
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.168.0.0", 16], // RFC1918
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved
  ["255.255.255.255", 32], // broadcast
];

function isBlockedIPv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n === null) return false;
  return BLOCKED_V4_CIDRS.some((cidr) => inCidr(n, cidr));
}

function expandIPv6(ip: string): string | null {
  // Strip zone id (e.g. "fe80::1%eth0").
  const noZone = ip.split("%")[0];
  if (!/^[0-9a-fA-F:.]+$/.test(noZone)) return null;
  // Split on the double-colon at most once.
  const parts = noZone.split("::");
  if (parts.length > 2) return null;
  const head = parts[0] === "" ? [] : parts[0].split(":");
  const tail = parts.length === 2 ? (parts[1] === "" ? [] : parts[1].split(":")) : [];
  // IPv4-mapped tail (e.g. ::ffff:127.0.0.1) — convert to two hextets.
  let extraHex: string[] = [];
  if (tail.length > 0 && tail[tail.length - 1].includes(".")) {
    const v4 = tail.pop()!;
    const n = ipv4ToInt(v4);
    if (n === null) return null;
    extraHex = [
      ((n >>> 16) & 0xffff).toString(16),
      (n & 0xffff).toString(16),
    ];
  }
  const knownLen = head.length + tail.length + extraHex.length;
  if (knownLen > 8) return null;
  const fillLen = parts.length === 2 ? 8 - knownLen : 0;
  const filled = [...head, ...Array(fillLen).fill("0"), ...tail, ...extraHex];
  if (filled.length !== 8) return null;
  return filled
    .map((h) => h.padStart(4, "0").toLowerCase())
    .join(":");
}

function isBlockedIPv6(ip: string): boolean {
  const expanded = expandIPv6(ip);
  if (!expanded) return false;
  if (expanded === "0000:0000:0000:0000:0000:0000:0000:0001") return true; // ::1
  if (expanded === "0000:0000:0000:0000:0000:0000:0000:0000") return true; // ::
  // Unique local fc00::/7 → first byte 0xfc or 0xfd.
  const firstByte = parseInt(expanded.slice(0, 2), 16);
  if ((firstByte & 0xfe) === 0xfc) return true;
  // Link-local fe80::/10 → first byte 0xfe, top two bits of second byte 0b10.
  if (firstByte === 0xfe) {
    const secondByte = parseInt(expanded.slice(2, 4), 16);
    if ((secondByte & 0xc0) === 0x80) return true;
  }
  // IPv4-mapped ::ffff:a.b.c.d → check the last two hextets as v4.
  if (expanded.startsWith("0000:0000:0000:0000:0000:ffff:")) {
    const tail = expanded.slice("0000:0000:0000:0000:0000:ffff:".length);
    const [hi, lo] = tail.split(":").map((h) => parseInt(h, 16));
    if (Number.isFinite(hi) && Number.isFinite(lo)) {
      const v4 =
        `${(hi >>> 8) & 0xff}.${hi & 0xff}.${(lo >>> 8) & 0xff}.${lo & 0xff}`;
      if (isBlockedIPv4(v4)) return true;
    }
  }
  return false;
}

function isBlockedLiteralIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return isBlockedIPv4(ip);
  if (v === 6) return isBlockedIPv6(ip);
  return false;
}

function isBlockedHostname(host: string): boolean {
  const h = host.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(h)) return true;
  // *.localhost MUST resolve to loopback per RFC 6761.
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  // *.internal is conventionally used for internal-only services
  // (Replit, GCE, GKE all use it). Block defensively.
  if (h.endsWith(".internal")) return true;
  return false;
}

export type ResolveFn = (host: string) => Promise<string[]>;

export interface CheckPrivateHostOptions {
  /**
   * Optional DNS resolver. When supplied, every returned A/AAAA record
   * is checked against the same blocked-range table so a public
   * hostname that resolves to a private IP is also rejected.
   * Inject a stub in tests; when omitted, only literal-IP / textual
   * hostname checks run.
   */
  resolve?: ResolveFn;
}

/**
 * Validates that `urlString` does not target an internal / loopback /
 * link-local / cloud-metadata host. Returns `{ ok: true }` on success,
 * `{ ok: false, reason, blockedIps? }` otherwise. The function is
 * intentionally permissive on shape errors (e.g. unparseable URL) —
 * those should be caught upstream by the URL validator before this
 * guard runs.
 */
export async function checkPrivateHost(
  urlString: string,
  options: CheckPrivateHostOptions = {},
): Promise<PrivateHostGuardResult> {
  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    return { ok: false, reason: "url is not parseable" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: `unsupported protocol "${parsed.protocol}"` };
  }
  let host = parsed.hostname;
  if (host.length === 0) {
    return { ok: false, reason: "url has no host" };
  }
  // Some Node versions surface IPv6 hostnames with the surrounding []
  // (per WHATWG URL); strip them so isIP() / our IPv6 expander see the
  // bare address.
  if (host.startsWith("[") && host.endsWith("]")) {
    host = host.slice(1, -1);
  }
  // Strip a trailing dot from FQDNs.
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (isIP(host)) {
    if (isBlockedLiteralIp(host)) {
      return {
        ok: false,
        reason: `host ${host} is in a blocked range (loopback / RFC1918 / link-local / cloud-metadata)`,
        blockedIps: [host],
      };
    }
    return { ok: true, addresses: [host] };
  }
  if (isBlockedHostname(host)) {
    return {
      ok: false,
      reason: `hostname "${host}" resolves to an internal-only network by convention`,
    };
  }
  if (options.resolve) {
    let addrs: string[];
    try {
      addrs = await options.resolve(host);
    } catch (err) {
      return {
        ok: false,
        reason: `dns resolution failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (addrs.length === 0) {
      return { ok: false, reason: "hostname did not resolve to any address" };
    }
    const blocked = addrs.filter(isBlockedLiteralIp);
    if (blocked.length > 0) {
      return {
        ok: false,
        reason: `hostname resolves to a blocked address (loopback / RFC1918 / link-local / cloud-metadata)`,
        blockedIps: blocked,
      };
    }
    // Return the validated address set so callers can pin one of them
    // for the actual outbound connect — they MUST NOT call the
    // resolver a second time (DNS rebinding TOCTOU).
    return { ok: true, addresses: addrs };
  }
  return { ok: true };
}

/**
 * Convenience resolver backed by `node:dns/promises` that returns
 * every A and AAAA record concatenated. Defined here so callers can
 * import a single ready-to-use function instead of plumbing both
 * lookups themselves.
 */
export async function resolveAllAddresses(host: string): Promise<string[]> {
  const dns = await import("node:dns/promises");
  const out: string[] = [];
  const families: Array<"resolve4" | "resolve6"> = ["resolve4", "resolve6"];
  for (const fn of families) {
    try {
      const records = await dns[fn](host);
      for (const r of records) {
        if (typeof r === "string") out.push(r);
      }
    } catch {
      // ENOTFOUND / NODATA — ignore and fall through; the caller
      // treats an empty result as a rejection.
    }
  }
  return out;
}

// Internal helpers exported for unit tests so they can exercise the
// CIDR / IPv6 expansion logic without going through the URL wrapper.
export const __TESTING__ = {
  isBlockedIPv4,
  isBlockedIPv6,
  isBlockedHostname,
  expandIPv6,
};

// Suppress unused-import warning in build output — `isIPv4` is kept
// available for future per-family branching but currently unused.
void isIPv4;
