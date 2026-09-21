/**
 * System-default egress allowlist (Epic #395 #414).
 *
 * Default-deny outbound network: every E2B template gets only the hosts
 * listed below plus whatever the per-`Project.sandboxEgressAllowlist`
 * adds. This is the minimum required for `npm install` / `pip install`
 * + GitHub clone to succeed. Customers needing more must opt in
 * explicitly on their Project.
 */
import { SandboxEgressValidationError } from "./types.js";

export const SYSTEM_DEFAULT_EGRESS_ALLOWLIST: readonly string[] = Object.freeze([
  // npm
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  // PyPI
  "pypi.org",
  "files.pythonhosted.org",
  // GitHub (clone, API, raw)
  "github.com",
  "api.github.com",
  "objects.githubusercontent.com",
  "codeload.github.com",
  "raw.githubusercontent.com",
]);

const FORBIDDEN_PATTERNS: readonly RegExp[] = [
  /^\*$/,
  /^\*\..*$/, // *.example.com
  /^0\.0\.0\.0/, // 0.0.0.0/0
  /^::\/0$/, // IPv6 default
  /^\d+\.\d+\.\d+\.\d+\/0$/, // CIDR /0
];

/**
 * Hostnames that resolve to cloud instance-metadata or other infrastructure
 * services that must never be reachable from a sandbox. These are denied
 * BEFORE the user-supplied allowlist is consulted (deny-by-default), so a
 * misconfigured project allowlist cannot accidentally — or maliciously —
 * grant access to credential-stealing endpoints (OWASP A10 SSRF, A05
 * Security Misconfiguration).
 */
const FORBIDDEN_METADATA_HOSTS: ReadonlySet<string> = new Set([
  "metadata.google.internal",
  "metadata.goog",
  "metadata.aws.internal",
  "metadata.azure.com",
  "metadata.azure.internal",
]);

/** IPv4 dotted-quad. Returns null when not a v4 literal. */
function parseIpv4(input: string): [number, number, number, number] | null {
  const m = input.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const parts = m.slice(1, 5).map((n) => Number(n));
  if (parts.some((n) => n < 0 || n > 255)) return null;
  return [parts[0], parts[1], parts[2], parts[3]];
}

/** Strip a `/N` CIDR suffix and return the address half (or `null` if N is invalid). */
function stripCidr(input: string): { addr: string; prefix: number | null } {
  const slash = input.indexOf("/");
  if (slash === -1) return { addr: input, prefix: null };
  const addr = input.slice(0, slash);
  const prefix = Number(input.slice(slash + 1));
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 128) {
    return { addr, prefix: NaN };
  }
  return { addr, prefix };
}

/**
 * True when `host` resolves to (or is) a literal/CIDR in one of the
 * deny-by-default ranges:
 *   - 169.254.169.254               IMDS (AWS / GCP / Azure)
 *   - 169.254.0.0/16                Link-local IPv4
 *   - 127.0.0.0/8                   IPv4 loopback
 *   - 10.0.0.0/8                    RFC1918
 *   - 172.16.0.0/12                 RFC1918
 *   - 192.168.0.0/16                RFC1918
 *   - ::1                           IPv6 loopback
 *   - fe80::/10                     IPv6 link-local
 *   - fc00::/7                      IPv6 unique-local
 *
 * Hostnames in `FORBIDDEN_METADATA_HOSTS` always match. We do NOT do live
 * DNS resolution here — that would be both slow and unreliable in a
 * validation path. Vendors are expected to enforce the deny list at the
 * firewall layer; this validator stops the obvious literal cases at the
 * configuration boundary so a typo cannot widen the egress surface.
 */
export function isForbiddenEgressTarget(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  if (!normalized) return false;
  if (FORBIDDEN_METADATA_HOSTS.has(normalized)) return true;

  const { addr, prefix } = stripCidr(normalized);
  if (prefix !== null && Number.isNaN(prefix)) {
    // Malformed CIDR — caller will get a wildcard / parse error elsewhere.
    return false;
  }

  // IPv6 — handle the small set of literals we care about. We do NOT
  // attempt full IPv6 CIDR math; the explicit prefixes below cover the
  // ranges identified by the security review.
  if (addr.includes(":")) {
    if (addr === "::1" || addr === "[::1]") return true;
    // Strip optional brackets for `[fe80::1]` style.
    const a = addr.replace(/^\[/, "").replace(/\]$/, "");
    if (a.startsWith("fe80:") || a === "fe80::") return true;
    if (/^f[cd][0-9a-f]{2}:/.test(a)) return true; // fc00::/7
    return false;
  }

  const v4 = parseIpv4(addr);
  if (!v4) return false;
  const [a, b] = v4;

  // 127.0.0.0/8 — IPv4 loopback
  if (a === 127) return true;
  // 10.0.0.0/8
  if (a === 10) return true;
  // 172.16.0.0/12
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16
  if (a === 192 && b === 168) return true;
  // 169.254.0.0/16 — link-local + IMDS
  if (a === 169 && b === 254) return true;
  // 0.0.0.0/8 — "this network" (unspecified / source-only)
  if (a === 0) return true;

  return false;
}

/**
 * Throws when the allowlist contains forbidden wildcards or a target in a
 * deny-by-default range (loopback, RFC1918, link-local, IMDS).
 */
export function validateEgressAllowlist(hosts: readonly string[]): void {
  for (const host of hosts) {
    if (typeof host !== "string" || host.trim().length === 0) {
      throw new SandboxEgressValidationError(`egress allowlist contains an empty entry`);
    }
    const normalized = host.trim().toLowerCase();
    for (const pattern of FORBIDDEN_PATTERNS) {
      if (pattern.test(normalized)) {
        throw new SandboxEgressValidationError(
          `egress allowlist may not contain wildcard '${host}'`,
        );
      }
    }
    if (isForbiddenEgressTarget(normalized)) {
      throw new SandboxEgressValidationError(
        `egress allowlist may not target instance metadata, loopback, RFC1918, or link-local addresses: '${host}'`,
      );
    }
  }
}

/**
 * Merge the system defaults with caller-supplied hosts (project + per-call),
 * de-duplicate, and validate. The returned list is the source of truth
 * passed to the vendor SDK firewall config.
 */
export function buildEffectiveEgressAllowlist(callerHosts: readonly string[] = []): string[] {
  validateEgressAllowlist(callerHosts);
  const merged = new Set<string>(SYSTEM_DEFAULT_EGRESS_ALLOWLIST);
  for (const host of callerHosts) merged.add(host.trim().toLowerCase());
  return Array.from(merged).sort();
}
