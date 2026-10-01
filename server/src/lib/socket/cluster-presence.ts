/**
 * #651 — presence lists ("who is viewing") that span every replica.
 *
 * Each replica keeps its own sockets' presence in memory (artifact presence in
 * `collaboration/presence.ts`, thread presence in `discussion-presence.ts`), and
 * the UI (`PresenceAvatars`) replaces its whole list with each
 * `presence:update`. So a list must be the WHOLE cluster's, or a viewer's
 * avatars flip between replicas' partial lists (#622 kept them local for that).
 *
 * On a clustered server (the Postgres adapter, #622) a change works like this:
 *   1. The replica where it happened relays `changed(room)` to every other
 *      replica (`serverSideEmit`, no ack) and refreshes its own viewers.
 *   2. A replica refreshes a room only when it holds a socket in it. A refresh
 *      asks every other replica for its LOCAL members of the room
 *      (`serverSideEmit` with an ack), merges them with its own, and emits the
 *      merged list to its own sockets only (`io.local`). Each replica's viewers
 *      are therefore fed by that replica alone, in the order it computed — no
 *      two replicas' lists race for one client.
 *   3. Refreshes of one room never overlap: a change that arrives while one is
 *      in flight marks the room dirty, and one more refresh runs after it. The
 *      last list a viewer receives was gathered after the last change.
 *
 * A replica that dies without a clean disconnect (no `disconnect` events, no
 * relay) is dropped by the adapter once its heartbeat lapses
 * (`heartbeatTimeout`, 10 s by default, swept every second — socket.io-adapter
 * 2.5.6 `ClusterAdapterWithHeartbeat`). `cluster-adapter.ts` announces that
 * removal on the adapter (`ADAPTER_NODE_REMOVED_EVENT`), and every replica then
 * refreshes each room it has viewers in — so a dead replica's viewers stop
 * counting within about `heartbeatTimeout` + 1 s. A gather in flight when a peer
 * dies resolves at its removal (the adapter settles requests waiting on it) or
 * at the adapter's 5 s request timeout, with the answers it has.
 *
 * A partition that heals re-merges every list. While it lasted, changes were
 * never relayed and each side's adapter dropped the other, so nothing else would
 * re-list a room until a viewer joined or left it. When the replica's `LISTEN`
 * connection is re-established (`onAdapterListening`, #649), it relays `resync`,
 * then relays `changed` for, and refreshes, every room it has viewers in. Each
 * peer answers a `resync` the same way for every room IT has viewers in. The
 * healed replica's adapter counts a peer again as soon as any message of the
 * peer's arrives, so that peer's `changed` makes it gather again with the peer
 * included. A replica with no viewers sends nothing: a booting one has nothing
 * to repair, and so a boot never makes every peer re-list every room. What that
 * leaves unrepaired: a replica whose LAST viewer of a room left during a
 * partition shorter than `heartbeatTimeout`, its relay lost, stays in its peers'
 * list of that room until the next change there.
 *
 * The cost: a change costs one relay, and each replica with viewers in the room
 * one request and N-1 responses over Postgres NOTIFY. Without the cluster
 * adapter nothing is relayed and a refresh is the local list, emitted at once.
 */
import type { MetisIOServer } from "./server.js";
import { createChildLogger } from "../logger.js";
import { runDetached } from "./client-event-handler.js";
import { asRelayServer } from "./revocation-relay.js";

const log = createChildLogger("socket:cluster-presence");

/** One socket's entry in a presence list (`presence:update` `users[]`). */
export interface PresenceMember {
  userId: string;
  username: string;
  displayName: string;
}

/**
 * Emitted on a namespace adapter by `cluster-adapter.ts` when the adapter drops
 * a peer replica (heartbeat lapsed, or the peer closed its adapter).
 */
export const ADAPTER_NODE_REMOVED_EVENT = "metis:node-removed";

/** The server-side events one presence kind relays between replicas. */
export function presenceRelayEvents(kind: string): {
  changed: string;
  members: string;
  resync: string;
} {
  return {
    changed: `metis:presence:${kind}:changed`,
    members: `metis:presence:${kind}:members`,
    resync: `metis:presence:${kind}:resync`,
  };
}

export interface ClusterPresenceOptions {
  /** Distinguishes artifact from thread presence on the relay; e.g. `"artifact"`. */
  kind: string;
  /** Whether `io` runs the cluster adapter. False: local lists, nothing relayed. */
  clustered: boolean;
  /** This replica's present members of `room`. */
  localMembers(room: string): PresenceMember[];
  /**
   * The cluster adapter's `onListening` (#649): registers a callback for every
   * (re)established `LISTEN` connection, on which every list is re-merged.
   */
  onAdapterListening?: (listener: () => void) => void;
}

export interface ClusterPresence {
  /** A member joined or left `room` on this replica: refresh every replica's viewers. */
  changed(room: string): void;
}

/** The slice of a namespace adapter read here; the in-memory one has `rooms` too. */
interface RoomAdapter {
  rooms: Map<string, Set<string>>;
  on?(event: string, listener: (...args: unknown[]) => void): unknown;
}

function isMember(value: unknown): value is PresenceMember {
  if (!value || typeof value !== "object") return false;
  const m = value as Record<string, unknown>;
  return (
    typeof m.userId === "string" &&
    typeof m.username === "string" &&
    typeof m.displayName === "string"
  );
}

export function createClusterPresence(
  io: MetisIOServer,
  opts: ClusterPresenceOptions,
): ClusterPresence {
  const emitList = (room: string, users: PresenceMember[]): void => {
    io.local.to(room).emit("presence:update", { room, users, ts: Date.now() });
  };

  if (!opts.clustered) {
    return { changed: (room) => emitList(room, opts.localMembers(room)) };
  }

  const relay = asRelayServer(io);
  const events = presenceRelayEvents(opts.kind);
  const adapter = (): RoomAdapter => io.of("/").adapter as unknown as RoomAdapter;
  const hasLocalSockets = (room: string): boolean => adapter().rooms.has(room);

  /** Rooms with a refresh in flight → whether another must follow it. */
  const inFlight = new Map<string, boolean>();
  /**
   * Rooms this replica has viewers in, as of its last refresh or change of each:
   * revisited when a peer replica is dropped or a partition heals. A room leaves
   * it with its last local viewer, so it never outgrows the rooms being viewed.
   */
  const known = new Set<string>();

  /** Every other replica's members of `room`, as many as answered. */
  const gatherRemote = (room: string): Promise<PresenceMember[]> =>
    new Promise((resolve) => {
      // The adapter always settles the ack: on every answer, at a silent peer's
      // removal, or at its request timeout (with the answers it has).
      relay.serverSideEmit(events.members, room, (err: Error | null, responses: unknown[]) => {
        if (err) {
          log.warn("presence gather incomplete — listing the replicas that answered", {
            room,
            error: err.message,
          });
        }
        resolve(
          (Array.isArray(responses) ? responses : [])
            .flatMap((r) => (Array.isArray(r) ? r : []))
            .filter(isMember)
            .map(({ userId, username, displayName }) => ({ userId, username, displayName })),
        );
      });
    });

  const refresh = (room: string): void => {
    if (inFlight.has(room)) {
      inFlight.set(room, true);
      return;
    }
    inFlight.set(room, false);
    known.add(room);
    runDetached(
      (async () => {
        try {
          do {
            inFlight.set(room, false);
            const remote = await gatherRemote(room);
            emitList(room, [...opts.localMembers(room), ...remote]);
          } while (inFlight.get(room));
        } finally {
          inFlight.delete(room);
          if (!hasLocalSockets(room)) known.delete(room);
        }
      })(),
      `presence refresh ${room}`,
    );
  };

  const relayOrLog = (event: string, ...args: string[]): void => {
    try {
      relay.serverSideEmit(event, ...args);
    } catch (err) {
      log.warn("could not relay a presence change to the other replicas", {
        event,
        room: args[0],
        error: (err as Error).message,
      });
    }
  };

  const changed = (room: string): void => {
    relayOrLog(events.changed, room);
    if (hasLocalSockets(room)) refresh(room);
    else known.delete(room);
  };

  /** Relay `changed` for, and refresh, every room this replica has viewers in. */
  const relayKnown = (): void => {
    for (const room of [...known]) {
      if (hasLocalSockets(room)) changed(room);
      else known.delete(room);
    }
  };

  // Replica-to-replica only: no client reaches these, and none can throw.
  asRelayServer(io).on(events.members, (...args: unknown[]) => {
    const [room, ack] = args;
    if (typeof ack !== "function") return;
    (ack as (members: PresenceMember[]) => void)(
      typeof room === "string" ? opts.localMembers(room) : [],
    );
  });

  asRelayServer(io).on(events.changed, (...args: unknown[]) => {
    const [room] = args;
    if (typeof room !== "string") return;
    if (hasLocalSockets(room)) refresh(room);
    else known.delete(room);
  });

  // A peer's partition healed: its viewers need this replica's members, and ours its.
  asRelayServer(io).on(events.resync, () => relayKnown());

  // #649 — this replica's own partition healed. A throw is logged by the adapter.
  opts.onAdapterListening?.(() => {
    if (known.size === 0) return;
    relayOrLog(events.resync);
    relayKnown();
  });

  // eslint-disable-next-line no-restricted-syntax -- #651: the namespace adapter's own event, emitted by `announceNodeRemoval`, which catches a listener's throw; no client reaches it
  adapter().on?.(ADAPTER_NODE_REMOVED_EVENT, () => {
    for (const room of known) {
      if (hasLocalSockets(room)) refresh(room);
      else known.delete(room);
    }
  });

  return { changed };
}
