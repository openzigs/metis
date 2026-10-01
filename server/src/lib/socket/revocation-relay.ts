/**
 * #613 / #622 — the revocation and eviction epochs, and the relay that moves
 * them on every replica.
 *
 * #613: a revocation (`disconnectUserSockets` / `reconnectUserSockets`) or an
 * MCP status eviction reaches only sockets already in the room it targets. A
 * handshake or `subscribe:mcp` that read live state BEFORE the revocation
 * committed, but joins its room only AFTER the revocation ran, is missed. So
 * each revocation bumps an epoch before it acts, and the handshake /
 * `subscribe:mcp` snapshot it before their read and re-read once it has moved.
 *
 * #622: with the cluster adapter the revocation itself reaches every replica,
 * but an epoch bumped only on the replica that handled it leaves a handshake in
 * flight on ANOTHER replica un-rechecked — #613's race, across replicas. So on a
 * clustered server every revocation is also relayed with `serverSideEmit`, and
 * each receiving replica bumps its own epoch and then repeats the revocation
 * against its LOCAL sockets. The repeat is idempotent and makes the outcome
 * independent of the order in which the relay and the adapter's own
 * cluster-wide operation arrive: if the relay lands before a pending socket
 * joins, the moved epoch makes it re-read; if after, the local repeat finds it
 * in the room.
 *
 * Epochs are kept per Socket.IO server. A deployment runs one server per
 * process, so that is the process-wide counter #613 describes; keying it by
 * server is what lets two in-process "replicas" in the test suites hold
 * separate epochs, as two real processes do. Each counts EVERY revocation of
 * its kind, not per user or workspace: a read in flight during any revocation
 * does one extra re-read — a bounded cost traded against keeping (and pruning)
 * a per-user map.
 *
 * With the in-memory adapter nothing is relayed: `serverSideEmit` is
 * unsupported there, and there is no other replica to tell.
 */
import { createChildLogger } from "../logger.js";
import type { MetisIOServer } from "./server.js";

const log = createChildLogger("socket-revocation-relay");

export type EpochKind = "revocation" | "eviction";

const epochs = new WeakMap<object, Record<EpochKind, number>>();

function counters(io: MetisIOServer): Record<EpochKind, number> {
  let c = epochs.get(io);
  if (!c) {
    c = { revocation: 0, eviction: 0 };
    epochs.set(io, c);
  }
  return c;
}

/** The current `kind` epoch of `io`. */
export function readEpoch(io: MetisIOServer, kind: EpochKind): number {
  return epochs.get(io)?.[kind] ?? 0;
}

/** Move the `kind` epoch of `io` — before the revocation it announces acts. */
export function bumpEpoch(io: MetisIOServer, kind: EpochKind): void {
  counters(io)[kind]++;
}

/**
 * The server-side-event surface. `MetisIOServer` declares no server-side
 * events, and widening its generic would ripple through every typed `Socket`.
 */
interface RelayServer {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  serverSideEmit(event: string, ...args: unknown[]): unknown;
}
function asRelayServer(io: MetisIOServer): RelayServer {
  return io as unknown as RelayServer;
}

/** Servers built with the cluster adapter, whose revocations are relayed. */
const clustered = new WeakSet<object>();

/**
 * Relay `event` to every other replica when `io` is clustered; a no-op on the
 * in-memory adapter. Best-effort: a failure is logged, never thrown.
 */
export function relayRevocation(io: MetisIOServer, event: string, ...args: string[]): void {
  if (!clustered.has(io)) return;
  try {
    asRelayServer(io).serverSideEmit(event, ...args);
  } catch (err) {
    log.warn("could not relay a socket revocation to the other replicas", {
      event,
      error: (err as Error).message,
    });
  }
}

/**
 * On a clustered server, run `apply` for each relayed `event` whose `arity`
 * arguments are all non-empty strings. A malformed relay is ignored; a throw
 * from `apply` is logged. A no-op when `isClustered` is false.
 */
export function onRelayedRevocation(
  io: MetisIOServer,
  isClustered: boolean,
  event: string,
  arity: number,
  apply: (...args: string[]) => void,
): void {
  if (!isClustered) return;
  clustered.add(io);
  asRelayServer(io).on(event, (...args: unknown[]) => {
    const values = args.slice(0, arity);
    if (values.length !== arity) return;
    if (!values.every((v): v is string => typeof v === "string" && v.length > 0)) return;
    try {
      apply(...values);
    } catch (err) {
      log.warn("could not apply a relayed socket revocation", {
        event,
        error: (err as Error).message,
      });
    }
  });
}
