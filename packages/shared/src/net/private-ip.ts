/**
 * Single source of truth for "is this IP literal in a non-routable range?"
 *
 * Issue #299 — three implementations of this check used to live across the
 * server (`connectors/network-allowlist.ts`, `publishing/host-allowlist.ts`,
 * `documents/url-fetcher.ts`) plus an inline copy in `mcp/http-transport.ts`.
 * They drifted on edge cases (one omitted multicast, another omitted CGNAT,
 * etc.). The canonical superset lives here and is imported by every caller.
 *
 * The classifier covers, per family:
 *
 * IPv4 (RFC 1918 + adjacent reserved blocks):
 *   - 0.0.0.0/8        — "this network" / unspecified
 *   - 10.0.0.0/8       — RFC 1918 private
 *   - 100.64.0.0/10    — RFC 6598 CGNAT
 *   - 127.0.0.0/8      — loopback
 *   - 169.254.0.0/16   — link-local + AWS metadata (169.254.169.254)
 *   - 172.16.0.0/12    — RFC 1918 private
 *   - 192.0.0.0/24     — RFC 6890 IETF protocol assignments
 *   - 192.0.2.0/24     — TEST-NET-1 documentation
 *   - 192.168.0.0/16   — RFC 1918 private
 *   - 198.18.0.0/15    — benchmarking
 *   - 198.51.100.0/24  — TEST-NET-2 documentation
 *   - 203.0.113.0/24   — TEST-NET-3 documentation
 *   - 224.0.0.0/4      — multicast
 *   - 240.0.0.0/4      — reserved (includes 255.255.255.255 broadcast)
 *
 * IPv6:
 *   - ::               — unspecified
 *   - ::1              — loopback
 *   - fe80::/10        — link-local
 *   - fc00::/7         — unique-local (ULA)
 *   - ff00::/8         — multicast
 *   - ::ffff:a.b.c.d   — IPv4-mapped IPv6, recursed through the IPv4 table
 *   - ::a.b.c.d        — IPv4-compatible IPv6 (deprecated, recursed)
 *
 * Inputs that are not parseable as an IP literal return `false` — callers
 * that want a hostname-aware policy resolve DNS first and feed every
 * resolved address through this helper.
 */

/**
 * Lightweight IP-family detector — `isIP`-equivalent without pulling in
 * `node:net`, so this module is browser-safe (the UI imports it via
 * `@metis/shared`).
 *
 * Returns `4` for an IPv4 dotted quad with octets in `0..255`, `6` for an
 * IPv6 literal that contains at least one `:` and only hex/`:`/`.`
 * characters with at most one `::` shorthand, or `0` otherwise.
 */
function isIP(value: string): 0 | 4 | 6 {
  if (!value) return 0;
  // IPv4 quick check.
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (v4) {
    for (let i = 1; i <= 4; i += 1) {
      const n = Number(v4[i]);
      if (!Number.isFinite(n) || n < 0 || n > 255) return 0;
    }
    return 4;
  }
  // IPv6 — must contain a colon, may contain a single `::`, and may end
  // with an embedded IPv4 dotted quad. We accept anything that fits the
  // permissive grammar; the classifier above this layer handles ranges.
  if (!value.includes(":")) return 0;
  if ((value.match(/::/g)?.length ?? 0) > 1) return 0;
  if (!/^[0-9a-fA-F:.]+$/.test(value)) return 0;
  return 6;
}

/** Strip surrounding `[ ]` from a bracketed IPv6 literal, if present. */
function stripBrackets(ip: string): string {
  return ip.replace(/^\[|\]$/g, "");
}

/**
 * True when `ip` is a syntactically-valid IPv4 literal in a non-routable
 * range. Malformed input (wrong octet count, out-of-range octets) returns
 * `true` — fail closed so a typo never opens an SSRF hole.
 */
export function isPrivateIPv4(ip: string): boolean {
  const octets = ip.split(".");
  if (octets.length !== 4) return true;
  const nums = octets.map((p) => Number.parseInt(p, 10));
  if (nums.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return true;
  const [a, b, c] = nums;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8 RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24 IETF
  if (a === 192 && b === 0 && c === 2) return true; // 192.0.2.0/24 TEST-NET-1
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24 TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24 TEST-NET-3
  if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved/broadcast
  return false;
}

/**
 * Expand an IPv6 literal to its eight 16-bit groups, handling `::`
 * zero-compression and a trailing embedded IPv4 dotted-quad. Returns `null`
 * for anything that is not a syntactically-valid IPv6 literal.
 *
 * The input is expected to be already lower-cased and bracket-stripped. A
 * trailing dotted quad (`::ffff:a.b.c.d`) is folded into two hex groups so
 * the dotted and hex representations of a mapped address canonicalise to the
 * identical group vector.
 */
function expandIPv6(input: string): number[] | null {
  let str = input;
  // Fold a trailing embedded IPv4 dotted-quad into two hex groups so
  // `::ffff:169.254.169.254` and `::ffff:a9fe:a9fe` share one code path.
  const dotted = /^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(str);
  if (dotted) {
    const quad = [dotted[2], dotted[3], dotted[4], dotted[5]].map((n) => Number.parseInt(n, 10));
    if (quad.some((n) => n < 0 || n > 255)) return null;
    const hi = ((quad[0] << 8) | quad[1]).toString(16);
    const lo = ((quad[2] << 8) | quad[3]).toString(16);
    str = `${dotted[1]}${hi}:${lo}`;
  }

  const halves = str.split("::");
  if (halves.length > 2) return null; // more than one `::` is illegal

  const toGroups = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    for (const seg of part.split(":")) {
      if (seg === "" || seg.length > 4 || !/^[0-9a-f]+$/.test(seg)) return null;
      out.push(Number.parseInt(seg, 16));
    }
    return out;
  };

  const head = toGroups(halves[0]);
  if (!head) return null;

  if (halves.length === 1) {
    // No `::` — must be exactly eight explicit groups.
    return head.length === 8 ? head : null;
  }

  const tail = toGroups(halves[1]);
  if (!tail) return null;
  const fill = 8 - head.length - tail.length;
  if (fill < 1) return null; // `::` must stand in for at least one zero group
  return [...head, ...new Array<number>(fill).fill(0), ...tail];
}

/** Render the low 32 bits (two 16-bit groups) as an IPv4 dotted quad. */
function embeddedV4(hi: number, lo: number): string {
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

/**
 * True when `ip` is a syntactically-valid IPv6 literal in a non-routable
 * range.
 *
 * IPv4-mapped IPv6 (`::ffff:a.b.c.d` / its hex normalisation
 * `::ffff:hhhh:hhhh`), IPv4-compatible IPv6 (`::a.b.c.d`) and NAT64
 * (`64:ff9b::a.b.c.d`) all carry a 32-bit IPv4 payload; the trailing 32 bits
 * are extracted and recursed through the IPv4 classifier so an attacker
 * cannot smuggle a private IPv4 (loopback / RFC1918 / link-local / CGNAT /
 * cloud IMDS) through a v6 wrapper. `new URL().hostname` normalises mapped
 * addresses to the hex form, so matching only the dotted form (issue #683)
 * classified every mapped private address as public and defeated all SSRF
 * egress guards. Malformed embedded literals fail closed (treated private).
 */
export function isPrivateIPv6(ip: string): boolean {
  const lower = stripBrackets(ip).toLowerCase();
  if (lower === "::" || lower === "::1") return true;
  // Link-local fe80::/10 spans fe80:: through febf:: (top 10 bits 1111111010),
  // so the old startsWith("fe80:") test missed fe81:: through febf:: (#689).
  // Mask the first hextet: parseInt stops at the first ":" and returns NaN for
  // "::"-prefixed inputs (already handled above).
  const linkLocalHextet = Number.parseInt(lower, 16);
  if (Number.isFinite(linkLocalHextet) && (linkLocalHextet & 0xffc0) === 0xfe80) return true;
  // ULA fc00::/7 — first byte is 0xfc or 0xfd.
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true;
  if (lower.startsWith("ff")) return true; // multicast ff00::/8

  const groups = expandIPv6(lower);
  if (groups) {
    const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;
    const highZero = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
    // IPv4-mapped ::ffff:0:0/96.
    if (highZero && g5 === 0xffff) return isPrivateIPv4(embeddedV4(g6, g7));
    // NAT64 well-known prefix 64:ff9b::/96 (g2..g5 = 0) and the RFC 8215
    // local-use prefix 64:ff9b:1::/48 (g2 = 1); both carry the embedded IPv4
    // in the trailing 32 bits (#689).
    if (
      g0 === 0x64 &&
      g1 === 0xff9b &&
      (g2 === 0 || g2 === 0x0001) &&
      g3 === 0 &&
      g4 === 0 &&
      g5 === 0
    ) {
      return isPrivateIPv4(embeddedV4(g6, g7));
    }
    // IPv4-compatible ::a.b.c.d (deprecated; whole `::/96` block bar ::/::1).
    if (highZero && g5 === 0) return isPrivateIPv4(embeddedV4(g6, g7));
    return false; // parsed, ordinary global unicast
  }

  // Unparseable but shaped like an embedded/mapped literal → fail closed.
  if (lower.startsWith("::ffff:") || lower.startsWith("::")) return true;
  return false;
}

/**
 * Classification label for a non-routable IP literal, or `null` when the
 * address is public / not an IP literal. This is the single source of truth
 * for both the boolean guards above and the structured errors thrown by
 * `safeFetch` (issue #302 previously duplicated this table in the server).
 */
export type PrivateIpClass =
  | "ipv4-private"
  | "ipv4-loopback"
  | "ipv4-link-local"
  | "ipv4-cgnat"
  | "ipv4-multicast"
  | "ipv4-reserved"
  | "ipv4-aws-metadata"
  | "ipv6-loopback"
  | "ipv6-link-local"
  | "ipv6-ula"
  | "ipv6-multicast"
  | "ipv6-mapped-private";

export function classifyPrivateIp(ip: string): PrivateIpClass | null {
  const h = stripBrackets(ip).toLowerCase();
  const fam = isIP(h);
  if (fam === 4) {
    if (!isPrivateIPv4(h)) return null;
    if (h === "169.254.169.254") return "ipv4-aws-metadata";
    if (/^127\./.test(h)) return "ipv4-loopback";
    if (/^169\.254\./.test(h)) return "ipv4-link-local";
    if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h)) return "ipv4-cgnat";
    const first = Number.parseInt(h.split(".")[0] ?? "0", 10);
    if (first >= 224) return "ipv4-multicast";
    if (/^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)) {
      return "ipv4-private";
    }
    return "ipv4-reserved";
  }
  if (fam === 6) {
    if (!isPrivateIPv6(h)) return null;
    if (h === "::1") return "ipv6-loopback";
    const linkLocalHextet = Number.parseInt(h, 16);
    if (Number.isFinite(linkLocalHextet) && (linkLocalHextet & 0xffc0) === 0xfe80) {
      return "ipv6-link-local";
    }
    if (/^f[cd][0-9a-f]{2}:/.test(h)) return "ipv6-ula";
    if (h.startsWith("ff")) return "ipv6-multicast";
    // Everything else private in v6 is an embedded/mapped IPv4 (or ::/::1).
    return "ipv6-mapped-private";
  }
  return null;
}

/**
 * True when `ip` is loopback / RFC1918 / link-local / ULA / unspecified /
 * CGNAT / multicast / reserved / IETF-documentation. Returns `false` for
 * inputs that are not parseable as an IP literal — pair with a DNS resolver
 * for hostname-aware policy.
 */
export function isPrivateIp(ip: string): boolean {
  const h = stripBrackets(ip).toLowerCase();
  const fam = isIP(h);
  if (fam === 4) return isPrivateIPv4(h);
  if (fam === 6) return isPrivateIPv6(h);
  return false;
}

/** Common loopback hostnames the network stack treats as 127/8 / ::1. */
export function isLoopbackHostname(host: string): boolean {
  const h = stripBrackets(host).toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "0.0.0.0";
}
