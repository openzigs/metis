/**
 * The one DNS-pinned `lookup` implementation in METIS (#750).
 *
 * Every pinned transport — `safeFetch`'s default dispatcher, the connector
 * allow-list's `makePinnedDispatcher`, the finops webhook sender, the
 * scheduler webhook task, the importer registry, Octokit and the database
 * drivers — builds its socket-level `lookup` here. There used to be a second
 * copy inside `safe-fetch.ts`; #13's `{ all: true }` fix never reached it, and
 * URL ingest, HTTP MCP servers, PagerDuty and eval drift alerts all broke on
 * Node 22 (#716). Do not reintroduce a local copy: the guard in
 * `server/tests/lib/net/pinned-lookup.test.ts` fails if one appears.
 *
 * This module deliberately has no imports beyond `node:net`, so the low-level
 * `net/` helpers can use it without pulling in config or logging.
 */
import { isIP } from "node:net";

/** Node `dns.lookup`-shaped callback as consumed by `net.connect`. */
export type PinnedLookup = (
  hostname: string,
  options: unknown,
  cb: (err: Error | null, address: string, family: number) => void,
) => void;

/**
 * Build a Node-style `lookup` callback that always resolves to the pre-pinned
 * IP address regardless of what `hostname` is requested. Wire this into pg /
 * mysql2 / mssql / Octokit's https.Agent / an undici `Agent` so the
 * kernel-level DNS lookup that happens AFTER host validation can't be
 * hijacked (M1 — DNS rebinding TOCTOU defence).
 *
 * Returns `undefined` when no address is pinned (e.g., loopback that wasn't
 * routed through the allow-list); callers can pass `undefined` straight to
 * the underlying driver, which falls back to the OS resolver.
 */
export function makePinnedLookup(
  pinnedAddress: string | undefined,
  family: 4 | 6 | undefined,
): PinnedLookup | undefined {
  if (!pinnedAddress) return undefined;
  const fam = family ?? (isIP(pinnedAddress) === 6 ? 6 : 4);
  return (_hostname, options, cb) => {
    // Node's `net.connect` asks for EVERY address (`{ all: true }`) whenever
    // `autoSelectFamily` is on, which is the default from Node 20. That form
    // expects an array of `{ address, family }` back; answering with the
    // single-address form makes Node read `undefined` as the IP and fail with
    // "Invalid IP address: undefined" — which broke every GitHub connector
    // test and ingest on Node 22 (#13), and every default `safeFetch` while it
    // kept its own copy (#716). Answer in whichever shape was asked for.
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
