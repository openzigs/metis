/**
 * #651 — `createClusterPresence` merges every replica's presence members into
 * the list each replica sends its own viewers. Driven against a fake server
 * whose `serverSideEmit` the test answers by hand; the two-replica proof over
 * the real adapter is `tests/socket-cluster-presence-622.test.ts`.
 */
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("../logger.js", () => ({
  createChildLogger: () => ({ warn, info: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

import {
  ADAPTER_NODE_REMOVED_EVENT,
  createClusterPresence,
  presenceRelayEvents,
  type PresenceMember,
} from "./cluster-presence.js";
import type { MetisIOServer } from "./server.js";

const EVENTS = presenceRelayEvents("artifact");
const ROOM = "presence:discussion:r1";

const member = (userId: string): PresenceMember => ({
  userId,
  username: userId,
  displayName: userId,
});

type Ack = (err: Error | null, responses: unknown[]) => void;

/** A fake server: `rooms` is its local adapter's rooms; gathers wait in `gathers`. */
function fakeServer() {
  const adapter = Object.assign(new EventEmitter(), { rooms: new Map<string, Set<string>>() });
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const emitted: Array<{ room: string; users: PresenceMember[] }> = [];
  const gathers: Array<{ room: unknown; ack: Ack }> = [];
  const serverSideEmit = vi.fn((event: string, ...args: unknown[]) => {
    if (event === EVENTS.members) gathers.push({ room: args[0], ack: args[1] as Ack });
  });
  const io = {
    local: {
      to: (room: string) => ({
        emit: (_event: string, payload: { users: PresenceMember[] }) =>
          emitted.push({ room, users: payload.users }),
      }),
    },
    of: () => ({ adapter }),
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      listeners.set(event, listener);
    }),
    serverSideEmit,
  } as unknown as MetisIOServer;
  return { io, adapter, listeners, emitted, gathers, serverSideEmit };
}

const flush = () => new Promise((r) => setImmediate(r));

afterEach(() => vi.clearAllMocks());

describe("createClusterPresence without the cluster adapter", () => {
  it("emits this replica's list at once, relays nothing and listens for nothing", () => {
    const { io, emitted, serverSideEmit } = fakeServer();
    const presence = createClusterPresence(io, {
      kind: "artifact",
      clustered: false,
      localMembers: () => [member("u1")],
    });

    presence.changed(ROOM);

    expect(emitted).toEqual([{ room: ROOM, users: [member("u1")] }]);
    expect(serverSideEmit).not.toHaveBeenCalled();
    expect(io.on).not.toHaveBeenCalled();
  });
});

describe("createClusterPresence with the cluster adapter", () => {
  function setup(local: PresenceMember[] = [member("u-local")]) {
    const server = fakeServer();
    const localMembers = vi.fn((_room: string) => local);
    const presence = createClusterPresence(server.io, {
      kind: "artifact",
      clustered: true,
      localMembers,
    });
    return { ...server, presence, localMembers };
  }

  it("relays the change and sends its viewers the merged list of every replica", async () => {
    const { presence, adapter, emitted, gathers, serverSideEmit } = setup();
    adapter.rooms.set(ROOM, new Set(["s1"]));

    presence.changed(ROOM);

    expect(serverSideEmit).toHaveBeenCalledWith(EVENTS.changed, ROOM);
    expect(gathers.map((g) => g.room)).toEqual([ROOM]);
    expect(emitted).toEqual([]);
    gathers[0].ack(null, [[member("u-b")], [member("u-c"), member("u-d")]]);
    await flush();

    expect(emitted).toEqual([
      { room: ROOM, users: [member("u-local"), member("u-b"), member("u-c"), member("u-d")] },
    ]);
  });

  it("keeps only well-formed members from a peer, stripped to the listed fields", async () => {
    const { presence, adapter, emitted, gathers } = setup([]);
    adapter.rooms.set(ROOM, new Set(["s1"]));
    presence.changed(ROOM);

    gathers[0].ack(null, [
      [{ ...member("u-b"), role: "admin" }, { userId: "u-x" }, null, "u-y"],
      "not-an-array",
    ]);
    await flush();

    expect(emitted).toEqual([{ room: ROOM, users: [member("u-b")] }]);
  });

  it("lists the replicas that answered when the gather times out, and logs it", async () => {
    const { presence, adapter, emitted, gathers } = setup();
    adapter.rooms.set(ROOM, new Set(["s1"]));
    presence.changed(ROOM);

    gathers[0].ack(new Error("timeout reached: missing 1 responses"), [[member("u-b")]]);
    await flush();

    expect(emitted).toEqual([{ room: ROOM, users: [member("u-local"), member("u-b")] }]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("presence gather incomplete"),
      expect.objectContaining({ room: ROOM }),
    );
  });

  it("relays but gathers nothing when no local socket is in the room", () => {
    const { presence, emitted, gathers, serverSideEmit } = setup();

    presence.changed(ROOM);

    expect(serverSideEmit).toHaveBeenCalledWith(EVENTS.changed, ROOM);
    expect(gathers).toEqual([]);
    expect(emitted).toEqual([]);
  });

  it("logs a relay that throws and still refreshes its own viewers", async () => {
    const { presence, adapter, emitted, gathers, serverSideEmit } = setup();
    adapter.rooms.set(ROOM, new Set(["s1"]));
    serverSideEmit.mockImplementationOnce(() => {
      throw new Error("adapter closed");
    });

    presence.changed(ROOM);
    gathers[0].ack(null, []);
    await flush();

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("could not relay a presence change"),
      expect.objectContaining({ room: ROOM, error: "adapter closed" }),
    );
    expect(emitted).toEqual([{ room: ROOM, users: [member("u-local")] }]);
  });

  it("never overlaps two refreshes of a room, and runs one more after changes made during one", async () => {
    let local = [member("u1")];
    const server = fakeServer();
    const presence = createClusterPresence(server.io, {
      kind: "artifact",
      clustered: true,
      localMembers: () => local,
    });
    server.adapter.rooms.set(ROOM, new Set(["s1"]));

    presence.changed(ROOM);
    local = [member("u1"), member("u2")];
    presence.changed(ROOM);
    presence.changed(ROOM);
    expect(server.gathers).toHaveLength(1);

    server.gathers[0].ack(null, []);
    await flush();
    // The second gather starts only once the first has been sent.
    expect(server.gathers).toHaveLength(2);
    server.gathers[1].ack(null, [[member("u-b")]]);
    await flush();

    expect(server.gathers).toHaveLength(2);
    expect(server.emitted.at(-1)).toEqual({
      room: ROOM,
      users: [member("u1"), member("u2"), member("u-b")],
    });

    // Settled: the next change gathers again.
    presence.changed(ROOM);
    expect(server.gathers).toHaveLength(3);
  });

  it("answers a peer's gather with this replica's members of the room", () => {
    const { listeners, localMembers } = setup();
    const ack = vi.fn();

    listeners.get(EVENTS.members)!(ROOM, ack);
    expect(localMembers).toHaveBeenCalledWith(ROOM);
    expect(ack).toHaveBeenCalledWith([member("u-local")]);

    ack.mockClear();
    listeners.get(EVENTS.members)!(42, ack);
    expect(ack).toHaveBeenCalledWith([]);

    // A relay with no ack to answer is ignored.
    expect(() => listeners.get(EVENTS.members)!(ROOM)).not.toThrow();
  });

  it("refreshes on a peer's change only when a local socket is in the room", () => {
    const { listeners, adapter, gathers } = setup();

    listeners.get(EVENTS.changed)!(ROOM);
    listeners.get(EVENTS.changed)!(7);
    expect(gathers).toEqual([]);

    adapter.rooms.set(ROOM, new Set(["s1"]));
    listeners.get(EVENTS.changed)!(ROOM);
    expect(gathers.map((g) => g.room)).toEqual([ROOM]);
  });

  it("re-lists every room it has viewers in when the adapter drops a peer replica", async () => {
    const { presence, adapter, gathers, emitted } = setup();
    const OTHER = "presence:discussion:r2";
    adapter.rooms.set(ROOM, new Set(["s1"]));
    adapter.rooms.set(OTHER, new Set(["s2"]));
    presence.changed(ROOM);
    presence.changed(OTHER);
    gathers.splice(0).forEach((g) => g.ack(null, [[member("u-dead")]]));
    await flush();
    emitted.length = 0;

    // The last viewer in OTHER left; the peer holding `u-dead` dies.
    adapter.rooms.delete(OTHER);
    adapter.emit(ADAPTER_NODE_REMOVED_EVENT, "peer-1");

    expect(gathers.map((g) => g.room)).toEqual([ROOM]);
    gathers[0].ack(null, []);
    await flush();
    expect(emitted).toEqual([{ room: ROOM, users: [member("u-local")] }]);

    // OTHER is forgotten: a later removal does not gather it even with a viewer back.
    gathers.length = 0;
    adapter.rooms.set(OTHER, new Set(["s3"]));
    adapter.emit(ADAPTER_NODE_REMOVED_EVENT, "peer-2");
    expect(gathers.map((g) => g.room)).toEqual([ROOM]);
  });

  /** Refresh ROOM once with a local viewer, so this replica tracks it. */
  async function viewed(server: ReturnType<typeof setup>) {
    server.adapter.rooms.set(ROOM, new Set(["s1"]));
    server.presence.changed(ROOM);
    server.gathers.splice(0).forEach((g) => g.ack(null, []));
    await flush();
  }

  /** Whether ROOM is still tracked: a peer's removal re-lists only tracked rooms. */
  function tracked(server: ReturnType<typeof setup>): boolean {
    server.gathers.length = 0;
    server.adapter.rooms.set(ROOM, new Set(["s9"]));
    server.adapter.emit(ADAPTER_NODE_REMOVED_EVENT, "peer-x");
    return server.gathers.some((g) => g.room === ROOM);
  }

  it("forgets a room when its last local viewer leaves", async () => {
    const server = setup();
    await viewed(server);
    expect(tracked(server)).toBe(true);
    server.gathers.splice(0).forEach((g) => g.ack(null, []));
    await flush();

    server.adapter.rooms.delete(ROOM);
    server.presence.changed(ROOM);

    expect(tracked(server)).toBe(false);
  });

  it("forgets a room on a peer's change once no local viewer is left in it", async () => {
    const server = setup();
    await viewed(server);

    server.adapter.rooms.delete(ROOM);
    server.listeners.get(EVENTS.changed)!(ROOM);

    expect(server.gathers).toEqual([]);
    expect(tracked(server)).toBe(false);
  });
});

describe("createClusterPresence after a partition heals (#649 onAdapterListening)", () => {
  function setup() {
    const server = fakeServer();
    let onListening: (() => void) | undefined;
    const presence = createClusterPresence(server.io, {
      kind: "artifact",
      clustered: true,
      localMembers: () => [member("u-local")],
      onAdapterListening: (listener) => {
        onListening = listener;
      },
    });
    return { ...server, presence, listening: () => onListening!() };
  }

  const OTHER = "presence:discussion:r2";

  async function viewing(server: ReturnType<typeof setup>, ...rooms: string[]) {
    for (const room of rooms) {
      server.adapter.rooms.set(room, new Set([`s-${room}`]));
      server.presence.changed(room);
    }
    server.gathers.splice(0).forEach((g) => g.ack(null, []));
    await flush();
    server.serverSideEmit.mockClear();
    server.emitted.length = 0;
  }

  it("asks every peer to re-list, and relays and refreshes each room it has viewers in", async () => {
    const server = setup();
    await viewing(server, ROOM, OTHER);
    server.adapter.rooms.delete(OTHER); // its last viewer left without a change

    server.listening();

    expect(server.serverSideEmit.mock.calls.filter((c) => c[0] !== EVENTS.members)).toEqual([
      [EVENTS.resync],
      [EVENTS.changed, ROOM],
    ]);
    expect(server.gathers.map((g) => g.room)).toEqual([ROOM]);
    server.gathers[0].ack(null, [[member("u-peer")]]);
    await flush();
    expect(server.emitted).toEqual([{ room: ROOM, users: [member("u-local"), member("u-peer")] }]);
  });

  it("sends nothing when it has no viewers, as on boot", () => {
    const server = setup();

    server.listening();

    expect(server.serverSideEmit).not.toHaveBeenCalled();
  });

  it("logs a resync relay that throws and still re-lists its rooms", async () => {
    const server = setup();
    await viewing(server, ROOM);
    server.serverSideEmit.mockImplementationOnce(() => {
      throw new Error("adapter closed");
    });

    server.listening();

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("could not relay a presence change"),
      expect.objectContaining({ event: EVENTS.resync, error: "adapter closed" }),
    );
    expect(server.gathers.map((g) => g.room)).toEqual([ROOM]);
  });

  it("answers a peer's resync by relaying and refreshing each room it has viewers in", async () => {
    const server = setup();
    await viewing(server, ROOM, OTHER);
    server.adapter.rooms.delete(OTHER);

    server.listeners.get(EVENTS.resync)!();

    expect(server.serverSideEmit.mock.calls.filter((c) => c[0] !== EVENTS.members)).toEqual([
      [EVENTS.changed, ROOM],
    ]);
    expect(server.gathers.map((g) => g.room)).toEqual([ROOM]);
  });
});
