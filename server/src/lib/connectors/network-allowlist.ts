/**
 * Network allow-list with DNS pinning for connectors (Phase 8 SEC).
 *
 * Both the repo connector (Octokit base URL) and every database driver MUST
 * route the resolved hostname through `assertConnectorHostAllowed` before
 * opening a socket. The check rejects RFC1918 / loopback / link-local / ULA
 * targets unless the hostname (or every resolved address) is on the matching
 * allow-list:
 *
 *   - REPO_ALLOWED_HOSTS — comma-separated allow-list for repo connectors.
 *   - DB_ALLOWED_HOSTS — comma-separated allow-list for database connectors.
 *   - PUBLISH_GITHUB_ALLOWED_HOSTS — additional GHE hosts allowed by the
 *     publisher (falls back to REPO_ALLOWED_HOSTS).
 *
 * Issue #262 (Phase 3) — these three keys are runtime tunables backed by
 * `ConfigService`. The compiled allow-list is cached in-process and rebuilt
 * synchronously on every `config.changed` event for one of the three keys
 * via `subscribeAllowlistToConfig`. In-flight requests use the snapshot
 * they were started with; the next request observes the new policy.
 *
 * Lifted from `mcp/http-transport.ts#assertSafeUrl` (Phase 6 SEC-1) so the
 * three subsystems share the same threat model.
 */
import { isIP } from "node:net";
import { promises as dns } from "node:dns";
import { isPrivateIp } from "@metis/shared";
import { type ConfigChangedEvent, type ConfigService, getConfigService } from "../config/index.js";
import { createChildLogger } from "../logger.js";
import type { DispatcherLike } from "../net/safe-fetch.js";
import { ConnectorError } from "./types.js";

const log = createChildLogger("connector-allowlist");

// Re-export the canonical classifier so existing callers (and tests) that
// import `isPrivateIp` from this module keep working after the #299
// consolidation. The function definition lives in `@metis/shared/net`.
export { isPrivateIp };

export type ConnectorKind = "repo" | "db" | "jira" | "xray" | "zephyr" | "testrail";

/** The runtime-config keys this module tracks. Order is irrelevant. */
const ALLOWLIST_KEYS = [
  "REPO_ALLOWED_HOSTS",
  "DB_ALLOWED_HOSTS",
  "PUBLISH_GITHUB_ALLOWED_HOSTS",
  "JIRA_ALLOWED_HOSTS",
  "XRAY_ALLOWED_HOSTS",
  "ZEPHYR_ALLOWED_HOSTS",
  "TESTRAIL_ALLOWED_HOSTS",
] as const;
type AllowlistKey = (typeof ALLOWLIST_KEYS)[number];

function isAllowlistKey(key: string): key is AllowlistKey {
  return (ALLOWLIST_KEYS as readonly string[]).includes(key);
}

/**
 * In-process compiled allow-list cache. `null` means "cold — recompile on
 * next read"; a `Set` is the snapshot in effect right now. Each subscriber
 * notification invalidates by setting the entry back to `null` so the next
 * read recomputes lazily — this avoids holding the event loop while the
 * registry walks every key.
 */
const compiled: Record<AllowlistKey, Set<string> | null> = {
  REPO_ALLOWED_HOSTS: null,
  DB_ALLOWED_HOSTS: null,
  PUBLISH_GITHUB_ALLOWED_HOSTS: null,
  JIRA_ALLOWED_HOSTS: null,
  XRAY_ALLOWED_HOSTS: null,
  ZEPHYR_ALLOWED_HOSTS: null,
  TESTRAIL_ALLOWED_HOSTS: null,
};

function readKeyFresh(key: AllowlistKey): string {
  try {
    return getConfigService().get(key) ?? "";
  } catch {
    // Registry unavailable (e.g. tests that bypass `getConfigService`) —
    // fall through to env so behaviour matches pre-#262 callers.
    return process.env[key] ?? "";
  }
}

function compileSet(raw: string): Set<string> {
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

function getCompiled(key: AllowlistKey): Set<string> {
  let snap = compiled[key];
  if (snap == null) {
    snap = compileSet(readKeyFresh(key));
    compiled[key] = snap;
  }
  return snap;
}

/**
 * True when `host` matches an allow-list entry.
 * Entries may be exact hostnames (`db1.example.com`) or wildcard prefixes
 * (`*.example.com`) that match any immediate or deeper subdomain.
 * IP literals are always matched exactly.
 */
function matchesAllowList(host: string, allow: string[]): boolean {
  const h = host.toLowerCase();
  return allow.some((entry) => {
    if (entry.startsWith("*.")) {
      const suffix = entry.slice(1); // e.g. ".example.com"
      return h === entry.slice(2) || h.endsWith(suffix);
    }
    return h === entry;
  });
}

/**
 * Return the lower-cased hostname allow-list for a connector kind.
 *
 * Repo callers also receive the union of `PUBLISH_GITHUB_ALLOWED_HOSTS` so
 * the publisher and the repo connector share a single source of truth and
 * an admin can scope-grant one host without inflating the other.
 */
function readAllowList(kind: ConnectorKind): string[] {
  if (kind === "db") return [...getCompiled("DB_ALLOWED_HOSTS")];
  if (kind === "jira") return [...getCompiled("JIRA_ALLOWED_HOSTS")];
  if (kind === "xray") return [...getCompiled("XRAY_ALLOWED_HOSTS")];
  if (kind === "zephyr") return [...getCompiled("ZEPHYR_ALLOWED_HOSTS")];
  if (kind === "testrail") return [...getCompiled("TESTRAIL_ALLOWED_HOSTS")];
  const merged = new Set<string>(getCompiled("REPO_ALLOWED_HOSTS"));
  for (const h of getCompiled("PUBLISH_GITHUB_ALLOWED_HOSTS")) merged.add(h);
  return [...merged];
}

/**
 * Issue #262 — invalidate every cached allow-list so the next read recomputes
 * from `ConfigService`. Exposed for direct callers (boot, tests) that need
 * to force a refresh without going through the event bus.
 */
export function rebuildConnectorAllowlists(): void {
  for (const key of ALLOWLIST_KEYS) compiled[key] = null;
}

let unsubscribe: (() => void) | null = null;

/**
 * Issue #262 — subscribe the in-process allow-list cache to `config.changed`
 * events. Returns an unsubscribe handle for graceful shutdown / tests.
 *
 * Idempotent: a second call without first unsubscribing replaces the
 * existing listener so a hot reload during development cannot stack
 * duplicates.
 */
export function subscribeAllowlistToConfig(svc: ConfigService = getConfigService()): () => void {
  if (unsubscribe) unsubscribe();
  const handler = (evt: ConfigChangedEvent): void => {
    if (!isAllowlistKey(evt.key)) return;
    compiled[evt.key] = null;
    log.info("Connector allow-list invalidated by config change", { key: evt.key });
  };
  svc.on("config.changed", handler);
  unsubscribe = (): void => {
    svc.off("config.changed", handler);
    unsubscribe = null;
  };
  return unsubscribe;
}

/** Test helper — clear the cache + drop the listener. */
export function __resetAllowlistForTests(): void {
  rebuildConnectorAllowlists();
  if (unsubscribe) unsubscribe();
}

export interface DnsLookupAddress {
  address: string;
  family: number;
}
export type DnsLookupAllFn = (host: string) => Promise<DnsLookupAddress[]>;

const defaultLookupAll: DnsLookupAllFn = async (host) => {
  const result = await dns.lookup(host, { all: true });
  return result;
};

function allowsLoopback(): boolean {
  // Tests + dev permit loopback by default; production demands explicit opt-in.
  return process.env.NODE_ENV !== "production" || process.env.CONNECTOR_ALLOW_LOOPBACK === "1";
}

function isLoopbackName(host: string): boolean {
  const h = stripBrackets(host);
  return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "0.0.0.0";
}

function stripBrackets(host: string): string {
  return host.replace(/^\[|\]$/g, "");
}

/** True when `ip` is loopback / RFC1918 / link-local / ULA / unspecified / CGNAT. */
// (Re-exported above from `@metis/shared`; the local definition that previously
// lived here was lifted to `packages/shared/src/net/private-ip.ts` in #299.)

/**
 * Validate a hostname against the connector allow-list. Resolves DNS to ALL
 * addresses, rejects if any is private/loopback unless explicitly allow-listed.
 *
 * @param host raw hostname (no scheme); IP literals also accepted
 * @param kind which env allow-list to consult (`REPO_ALLOWED_HOSTS` vs `DB_ALLOWED_HOSTS`)
 * @param lookup test-injectable DNS lookup
 * @throws ConnectorError(403, "HOST_NOT_ALLOWED", ...) on policy violation
 */
export async function assertConnectorHostAllowed(
  host: string,
  kind: ConnectorKind,
  lookup: DnsLookupAllFn = defaultLookupAll,
): Promise<void> {
  await resolveAndAssertConnectorHost(host, kind, lookup);
}

/**
 * Same policy as `assertConnectorHostAllowed` but also returns the validated
 * IP address that the caller MUST use when opening the socket. This is the
 * defence against DNS-rebinding TOCTOU: the validator and the connector share
 * the SAME pinned IP so a hostile DNS can't return a public IP at validation
 * time and a private IP at connect time. Callers should pass `family` to the
 * driver/agent's `lookup` callback so the kernel uses the pinned address.
 *
 * If `host` is an IP literal we return it verbatim. If `host` is a name we
 * return the FIRST address in the resolver result (consistent with what
 * `dns.lookup` without `all` would return) but ALL addresses are checked.
 */
export interface PinnedHost {
  hostname: string;
  /** The IP address that should actually receive the connection. */
  address: string;
  family: 4 | 6;
}

export async function resolveAndAssertConnectorHost(
  host: string,
  kind: ConnectorKind,
  lookup: DnsLookupAllFn = defaultLookupAll,
): Promise<PinnedHost> {
  if (!host || host.trim().length === 0) {
    throw new ConnectorError(400, "HOST_REQUIRED", "host is required");
  }
  const lower = host.trim().toLowerCase();
  const allow = readAllowList(kind);
  const onAllowList = matchesAllowList(lower, allow);
  const isLoopback = isLoopbackName(lower);

  // IP literal — short-circuit DNS.
  const fam = isIP(stripBrackets(lower));
  if (fam !== 0) {
    const ip = stripBrackets(lower);
    if (isPrivateIp(ip) && !onAllowList && !(isLoopback && allowsLoopback())) {
      throw new ConnectorError(
        403,
        "HOST_NOT_ALLOWED",
        `${kind} host ${ip} is private/loopback and not on the allow-list`,
      );
    }
    return { hostname: ip, address: ip, family: fam === 4 ? 4 : 6 };
  }

  if (isLoopback && (onAllowList || allowsLoopback())) {
    // Pin to IPv4 loopback by default — caller can override.
    return { hostname: lower, address: "127.0.0.1", family: 4 };
  }

  let addrs: DnsLookupAddress[];
  try {
    addrs = await lookup(lower);
  } catch (err) {
    throw new ConnectorError(
      502,
      "DNS_LOOKUP_FAILED",
      `${kind} host DNS lookup failed for ${lower}: ${(err as Error).message}`,
    );
  }
  if (!addrs || addrs.length === 0) {
    throw new ConnectorError(
      502,
      "DNS_LOOKUP_EMPTY",
      `${kind} host DNS lookup returned no addresses for ${lower}`,
    );
  }
  for (const a of addrs) {
    if (isPrivateIp(a.address) && !onAllowList && !matchesAllowList(a.address, allow)) {
      log.warn("Connector host blocked by allow-list", {
        kind,
        host: lower,
        resolved: a.address,
      });
      throw new ConnectorError(
        403,
        "HOST_NOT_ALLOWED",
        `${kind} host ${lower} resolves to private/loopback address ${a.address} — not on allow-list`,
      );
    }
  }
  const first = addrs[0];
  return {
    hostname: lower,
    address: first.address,
    family: first.family === 6 ? 6 : 4,
  };
}

/**
 * Build a Node-style `lookup` callback that always resolves to the pre-pinned
 * IP address regardless of what `hostname` is requested. Wire this into pg /
 * mysql2 / mssql / Octokit's https.Agent so the kernel-level DNS lookup that
 * happens AFTER `assertConnectorHostAllowed` can't be hijacked (M1 — DNS
 * rebinding TOCTOU defence).
 *
 * Returns `undefined` when no address is pinned (e.g., loopback that wasn't
 * routed through the allow-list); callers can pass `undefined` straight to
 * the underlying driver, which falls back to the OS resolver.
 */
export function makePinnedLookup(
  pinnedAddress: string | undefined,
  family: 4 | 6 | undefined,
):
  | ((
      hostname: string,
      options: unknown,
      cb: (err: Error | null, address: string, family: number) => void,
    ) => void)
  | undefined {
  if (!pinnedAddress) return undefined;
  const fam = family ?? (isIP(pinnedAddress) === 6 ? 6 : 4);
  return (_hostname, options, cb) => {
    // Node's `net.connect` asks for EVERY address (`{ all: true }`) whenever
    // `autoSelectFamily` is on, which is the default from Node 20. That form
    // expects an array of `{ address, family }` back; answering with the
    // single-address form makes Node read `undefined` as the IP and fail with
    // "Invalid IP address: undefined" — which broke every GitHub connector
    // test and ingest on Node 22. Answer in whichever shape was asked for.
    if (options && typeof options === "object" && (options as { all?: unknown }).all === true) {
      (
        cb as unknown as (
          err: Error | null,
          addresses: { address: string; family: number }[],
        ) => void
      )(null, [{ address: pinnedAddress, family: fam }]);
      return;
    }
    cb(null, pinnedAddress, fam);
  };
}

/**
 * Build an undici `Agent` whose connection layer always resolves to the
 * already-validated address from {@link resolveAndAssertConnectorHost}. This is
 * the `fetch`-flavoured counterpart to {@link makePinnedLookup}: drivers wire
 * the raw lookup into their own socket options, whereas `fetch` callers pass
 * this dispatcher through `RequestInit`. The original hostname is still used
 * for the Host header and TLS SNI — only the address the socket connects to is
 * pinned, which is what closes the DNS-rebinding TOCTOU window.
 *
 * `undici` is imported dynamically so test environments that stub `fetch`
 * never have to load it.
 */
export async function makePinnedDispatcher(pinned: PinnedHost): Promise<DispatcherLike> {
  const lookup = makePinnedLookup(pinned.address, pinned.family);
  if (!lookup) {
    // An empty address would mean something slipped past validation — throw
    // rather than silently fall back to the OS resolver (which re-opens the
    // rebinding hole).
    throw new ConnectorError(500, "PIN_UNAVAILABLE", "pinned lookup unavailable");
  }
  const undici = (await import("undici")) as unknown as {
    Agent: new (opts: { connect: { lookup: typeof lookup } }) => DispatcherLike;
  };
  return new undici.Agent({ connect: { lookup } });
}

/**
 * Corporate egress proxy resolution for connector requests to `hostname`,
 * honoring the standard `HTTPS_PROXY`/`HTTP_PROXY` + `NO_PROXY` convention
 * that `curl`/`git` already follow. Node's own `fetch` (undici) does NOT read
 * these env vars on its own, so a locked-down network that requires routing
 * all public-internet egress through a forward proxy (e.g. a public GitHub
 * host reachable only via `userproxy.corp.example.com:8080`) silently hangs
 * every `fetch`-based connector call until it times out — observed live
 * against a GitHub EMU org connector (2026-09).
 *
 * `NO_PROXY` entries are matched by HOSTNAME only: exact match, a bare or
 * `.`-prefixed suffix (`example.com` / `.example.com` matches `git.example.com`), a
 * `*.suffix` glob, or `*` to bypass every host. IP/CIDR entries (e.g.
 * `10.0.0.0/8`) are NOT matched — every connector host in practice is
 * name-based, so this is not presently a live gap, but a CIDR-only `NO_PROXY`
 * entry with no corresponding hostname suffix would still be proxied.
 */
export function resolveCorporateProxyUrl(hostname: string): string | undefined {
  const noProxy = process.env.NO_PROXY ?? process.env.no_proxy ?? "";
  const lowerHost = hostname.toLowerCase();
  const bypassed = noProxy
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .some((entry) => {
      if (entry === "*") return true;
      const suffix = entry.replace(/^\*/, "").replace(/^\./, "");
      return suffix.length > 0 && (lowerHost === suffix || lowerHost.endsWith(`.${suffix}`));
    });
  if (bypassed) return undefined;
  return (
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    undefined
  );
}

/**
 * The dispatcher a connector's `fetch` call should use for `pinned.hostname`:
 * a {@link resolveCorporateProxyUrl}-resolved `ProxyAgent` when the network
 * requires egressing through a corporate proxy for that host, otherwise the
 * usual DNS-pinned {@link makePinnedDispatcher}.
 *
 * Proxying intentionally supersedes DNS pinning rather than combining with
 * it: once a request is tunnelled through a forward proxy, the PROXY resolves
 * and connects to the target, so our own pinned lookup would never be
 * consulted — the proxy becomes the trusted network boundary instead, the
 * same posture every other outbound tool in a proxied environment already
 * relies on.
 */
export async function resolveConnectorDispatcher(pinned: PinnedHost): Promise<DispatcherLike> {
  const proxyUrl = resolveCorporateProxyUrl(pinned.hostname);
  if (!proxyUrl) return makePinnedDispatcher(pinned);
  const undici = (await import("undici")) as unknown as {
    ProxyAgent: new (url: string) => DispatcherLike;
  };
  return new undici.ProxyAgent(proxyUrl);
}
