/**
 * The one place that builds an undici dispatcher for Node's BUILT-IN `fetch`
 * (#308).
 *
 * Node 22's global `fetch` runs on the undici copy bundled into Node itself
 * (6.x on Node 22.22). It hands a dispatcher a LEGACY handler (`onConnect`,
 * `onHeaders`, `onData`, `onComplete`, `onError`). undici 8, the version in
 * `server/package.json`, removed its legacy-handler shim (nodejs/undici#4786).
 * Its `Agent` / `ProxyAgent` now accept only the v2 handler API
 * (`onRequestStart`, `onResponseStart`, ...). Pass one straight into
 * `globalThis.fetch({ dispatcher })` and every request fails with
 * `TypeError: fetch failed` / `InvalidArgumentError: invalid onRequestStart
 * method`.
 *
 * undici's own migration guide ("Migrating from Undici 7 to 8", section 6) says
 * to wrap such a dispatcher in `Dispatcher1Wrapper`. The wrapper translates a
 * legacy handler to the v2 API and passes a v2 handler through unchanged, so the
 * wrapped dispatcher also works with undici 8's own `fetch` / `request`. It also
 * forces `allowH2: false` for every request, which keeps these connections on
 * HTTP/1.1 exactly as they were on undici 7 (v8 turned on HTTP/2-over-ALPN by
 * default, nodejs/undici#4828).
 *
 * Construct every dispatcher that may reach the built-in `fetch` through this
 * module. `builtin-fetch-dispatcher.test.ts` fails if any other server file
 * constructs an undici `Agent` or `ProxyAgent` directly.
 */
import type { LookupFunction } from "node:net";
import { Agent, Dispatcher1Wrapper, ProxyAgent, type Dispatcher } from "undici";

/**
 * Any `dns.lookup`-shaped function. Each caller declares its own narrower
 * signature for the pinned lookup, and every one of them is assignable to this.
 */
export type LookupLike = (...args: never[]) => void;

/**
 * A `Dispatcher1Wrapper` that keeps a reference to the dispatcher it wraps, so a
 * test can read the real transport options (for example the provider's
 * `headersTimeout`) instead of the wrapper's.
 */
export class BuiltinFetchDispatcher extends Dispatcher1Wrapper {
  constructor(readonly inner: Dispatcher) {
    super(inner);
  }
}

/** Wrap an undici 8 dispatcher so Node's built-in `fetch` can drive it. */
export function forBuiltinFetch(inner: Dispatcher): BuiltinFetchDispatcher {
  return new BuiltinFetchDispatcher(inner);
}

/** An undici `Agent` for the built-in `fetch`, with the given options. */
export function agentForBuiltinFetch(options?: Agent.Options): BuiltinFetchDispatcher {
  return forBuiltinFetch(new Agent(options));
}

/**
 * An `Agent` whose every connection uses `lookup`. The callers pass a lookup
 * pinned to an already-validated IP, which closes the DNS-rebinding window.
 */
export function pinnedAgentForBuiltinFetch(lookup: LookupLike): BuiltinFetchDispatcher {
  return agentForBuiltinFetch({ connect: { lookup: lookup as LookupFunction } });
}

/** A `ProxyAgent` (corporate egress proxy) for the built-in `fetch`. */
export function proxyAgentForBuiltinFetch(proxyUrl: string): BuiltinFetchDispatcher {
  return forBuiltinFetch(new ProxyAgent(proxyUrl));
}
