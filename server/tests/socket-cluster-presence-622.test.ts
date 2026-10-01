/**
 * #622 / #651 — presence lists span every replica sharing the Postgres cluster
 * adapter.
 *
 * Each replica keeps its own sockets' presence in memory, and the UI
 * (`PresenceAvatars`) replaces its whole list with every `presence:update`. #622
 * kept each replica's list local so a viewer's avatars would not flip between
 * partial lists; #651 merges the lists (`socket/cluster-presence.ts`), so a
 * viewer on either replica sees every viewer, on both.
 *
 * Two real Socket.IO servers with the real `@socket.io/postgres-adapter` over the
 * in-process notify bus, each with its OWN artifact presence module instance and
 * its own thread presence (as two processes have).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Socket as ClientSocket } from "socket.io-client";
import { presenceRoom, threadRoom } from "@metis/shared";

// #679 — every viewer here may read the artifact; the join's access rule is
// covered in `socket.test.ts`.
vi.mock("../src/lib/socket/room-access.js", () => ({
  canJoinPresenceRoom: async () => true,
}));

// #651 — thread presence stays gated on `canAccessThread`: only `outsider` is refused.
vi.mock("../src/lib/discussions/access.js", () => ({
  canAccessThread: async (actor: { id: string }) =>
    actor.id === "outsider" ? { ok: false, reason: "forbidden" } : { ok: true },
}));

vi.mock("../src/lib/prisma.js", async () =>
  (await import("./helpers/two-replica-prisma.js")).prismaModuleMock(),
);

import { seed } from "./helpers/two-replica-prisma.js";
import { connectUser, startReplica, type Replica } from "./helpers/two-replica-sockets.js";
import { FakePgNotifyBus } from "./helpers/fake-pg-notify-bus.js";
import {
  createPostgresClusterAdapter,
  type SocketClusterAdapter,
  type SocketClusterHeartbeat,
} from "../src/lib/socket/cluster-adapter.js";

const ARTIFACT = { artifactType: "discussion", artifactId: "req-622" } as const;
const ROOM = presenceRoom(ARTIFACT.artifactType, ARTIFACT.artifactId);
const THREAD_ID = "thread-651";
const THREAD_ROOM = `thread:${THREAD_ID}`;

interface PresenceUpdate {
  room: string;
  users: Array<{ userId: string }>;
}

let a: Replica | undefined;
let b: Replica | undefined;
let adapters: SocketClusterAdapter[] = [];
const open: ClientSocket[] = [];

/** A fresh presence module, so each replica holds its own list as a process would. */
async function freshPresence() {
  vi.resetModules();
  return import("../src/lib/collaboration/presence.js");
}

afterEach(async () => {
  for (const s of open.splice(0)) s.close();
  await a?.close();
  await b?.close();
  await Promise.all(adapters.map((x) => x.close()));
  adapters = [];
});

/** Two replicas on one bus, with artifact presence wired as `src/server.ts` does. */
async function twoReplicas(heartbeat: SocketClusterHeartbeat = {}) {
  const bus = new FakePgNotifyBus();
  const pools = [bus.pool(), bus.pool()];
  adapters = pools.map((pool) => createPostgresClusterAdapter(pool, heartbeat));
  a = await startReplica(adapters[0].adapter, adapters[0].onListening);
  b = await startReplica(adapters[1].adapter, adapters[1].onListening);
  (await freshPresence()).wirePresenceHandlers(a.io, {
    clustered: true,
    onAdapterListening: adapters[0].onListening,
  });
  (await freshPresence()).wirePresenceHandlers(b.io, {
    clustered: true,
    onAdapterListening: adapters[1].onListening,
  });
  await vi.waitFor(async () => {
    expect(await a!.io.of("/").adapter.serverCount()).toBe(2);
    expect(await b!.io.of("/").adapter.serverCount()).toBe(2);
  });
  return { bus, pools, a, b };
}

/** Record every update this client sees for `room`. */
function record(socket: ClientSocket, room: string): PresenceUpdate[] {
  const seen: PresenceUpdate[] = [];
  socket.on("presence:update", (u: PresenceUpdate) => {
    if (u.room === room) seen.push(u);
  });
  return seen;
}

/** Join the artifact's presence room and record every update this client sees. */
function watch(socket: ClientSocket): PresenceUpdate[] {
  const seen = record(socket, ROOM);
  socket.emit("presence:join", ARTIFACT);
  return seen;
}

/** Join the thread's presence and record every update this client sees. */
function watchThread(socket: ClientSocket): PresenceUpdate[] {
  const seen = record(socket, THREAD_ROOM);
  socket.emit("presence:thread:join", { threadId: THREAD_ID });
  return seen;
}

const ids = (u: PresenceUpdate) => u.users.map((x) => x.userId).sort();
const latest = (seen: PresenceUpdate[]) => (seen.length ? ids(seen.at(-1)!) : []);

describe("#651 artifact presence spans every replica", () => {
  it("a viewer on A and a viewer on B each see both users", async () => {
    const { a, b } = await twoReplicas();
    seed(["v-a", "v-b"], []);

    const onA = await connectUser(a, "v-a", open);
    const seenOnA = watch(onA.socket);
    await vi.waitFor(() => expect(latest(seenOnA)).toEqual(["v-a"]));

    const onB = await connectUser(b, "v-b", open);
    const seenOnB = watch(onB.socket);

    await vi.waitFor(() => {
      expect(latest(seenOnB)).toEqual(["v-a", "v-b"]);
      expect(latest(seenOnA)).toEqual(["v-a", "v-b"]);
    });
    // B's viewer never saw a list without A's viewer in it.
    expect(seenOnB.map(ids)).toEqual(seenOnB.map(() => ["v-a", "v-b"]));
  });

  it.each([
    ["A", "v-a", "v-b"],
    ["B", "v-b", "v-a"],
  ] as const)(
    "a disconnect on %s removes that user from both viewers' lists",
    async (_replica, leaver, stayer) => {
      const { a, b } = await twoReplicas();
      seed(["v-a", "v-b", "v-b2"], []);
      const conns = {
        "v-a": await connectUser(a, "v-a", open),
        "v-b": await connectUser(b, "v-b", open),
      };
      const seen = { "v-a": watch(conns["v-a"].socket), "v-b": watch(conns["v-b"].socket) };
      // A third viewer on B, so a list is still sent to B after `v-b` leaves it.
      const third = await connectUser(b, "v-b2", open);
      const seenThird = watch(third.socket);
      await vi.waitFor(() => {
        expect(latest(seen["v-a"])).toEqual(["v-a", "v-b", "v-b2"]);
        expect(latest(seen["v-b"])).toEqual(["v-a", "v-b", "v-b2"]);
        expect(latest(seenThird)).toEqual(["v-a", "v-b", "v-b2"]);
      });

      conns[leaver].socket.close();

      const remaining = [stayer, "v-b2"].sort();
      await vi.waitFor(() => {
        expect(latest(seen[stayer])).toEqual(remaining);
        expect(latest(seenThird)).toEqual(remaining);
      });
    },
  );

  it("a replica that dies without disconnecting stops counting within the heartbeat timeout", async () => {
    const { bus, pools, a, b } = await twoReplicas({
      heartbeatInterval: 100,
      heartbeatTimeout: 400,
    });
    seed(["v-a", "v-b"], []);
    const seenOnA = watch((await connectUser(a, "v-a", open)).socket);
    watch((await connectUser(b, "v-b", open)).socket);
    await vi.waitFor(() => expect(latest(seenOnA)).toEqual(["v-a", "v-b"]));

    // B is cut off: no disconnect reaches A, and B's socket stays connected to B.
    const cutAt = Date.now();
    bus.sever(pools[1]);

    // Removed after `heartbeatTimeout` + the adapter's 1 s sweep — no client acts.
    await vi.waitFor(() => expect(latest(seenOnA)).toEqual(["v-a"]), { timeout: 4_000 });
    expect(Date.now() - cutAt).toBeLessThan(400 + 1_000 + 1_000);
    expect(await a.io.of("/").adapter.serverCount()).toBe(1);
    expect(b.io.of("/").adapter.rooms.get(ROOM)?.size).toBe(1);
  });

  it("re-merges both replicas' lists once a partition heals, with no client acting", async () => {
    const { bus, pools, a, b } = await twoReplicas({
      heartbeatInterval: 100,
      heartbeatTimeout: 400,
    });
    seed(["v-a", "v-a2", "v-b"], []);
    const onA = await connectUser(a, "v-a", open);
    const onB = await connectUser(b, "v-b", open);
    const seenOnA = watch(onA.socket);
    const seenOnB = watch(onB.socket);
    const threadOnA = watchThread(onA.socket);
    const threadOnB = watchThread(onB.socket);
    await vi.waitFor(() => {
      for (const seen of [seenOnA, seenOnB, threadOnA, threadOnB]) {
        expect(latest(seen)).toEqual(["v-a", "v-b"]);
      }
    });

    // B is partitioned: its LISTEN connection drops and cannot come back until
    // the heal; each side's adapter then drops the other.
    const listenB = [...bus.clients].find((c) => c.pool === pools[1])!;
    bus.sever(pools[1]);
    listenB.emit("end");
    await vi.waitFor(
      () => {
        expect(latest(seenOnA)).toEqual(["v-a"]);
        expect(latest(seenOnB)).toEqual(["v-b"]);
        expect(latest(threadOnA)).toEqual(["v-a"]);
        expect(latest(threadOnB)).toEqual(["v-b"]);
      },
      { timeout: 4_000 },
    );

    // A change during the partition: its relay never reaches B.
    const seenOnA2 = watch((await connectUser(a, "v-a2", open)).socket);
    await vi.waitFor(() => expect(latest(seenOnA2)).toEqual(["v-a", "v-a2"]));
    expect(latest(seenOnB)).toEqual(["v-b"]);

    bus.restore(pools[1]);

    // B's LISTEN is re-established (after the adapter's 1-3 s reconnect delay).
    const merged = ["v-a", "v-a2", "v-b"];
    await vi.waitFor(
      () => {
        expect(latest(seenOnA)).toEqual(merged);
        expect(latest(seenOnA2)).toEqual(merged);
        expect(latest(seenOnB)).toEqual(merged);
        expect(latest(threadOnA)).toEqual(["v-a", "v-b"]);
        expect(latest(threadOnB)).toEqual(["v-a", "v-b"]);
      },
      { timeout: 8_000 },
    );
  });
});

describe("#651 thread presence spans every replica, gated on canAccessThread", () => {
  it("viewers on both replicas see both users; an outsider is refused and never listed", async () => {
    const { a, b } = await twoReplicas();
    seed(["v-a", "v-b", "outsider"], []);

    const onA = await connectUser(a, "v-a", open);
    const seenOnA = watchThread(onA.socket);
    const onB = await connectUser(b, "v-b", open);
    const seenOnB = watchThread(onB.socket);

    await vi.waitFor(() => {
      expect(latest(seenOnA)).toEqual(["v-a", "v-b"]);
      expect(latest(seenOnB)).toEqual(["v-a", "v-b"]);
    });

    const outsider = await connectUser(b, "outsider", open);
    const denied = new Promise<{ message: string; room?: string }>((resolve) =>
      outsider.socket.once("auth:error", resolve),
    );
    const seenByOutsider = watchThread(outsider.socket);
    // #685 — a room-scoped refusal, so the UI does not show it as a global error.
    expect(await denied).toEqual({
      message: "FORBIDDEN: no access to discussion thread",
      room: threadRoom(THREAD_ID),
    });

    // A later change is still listed without the outsider, who never receives it.
    onB.socket.emit("presence:thread:leave", { threadId: THREAD_ID });
    await vi.waitFor(() => expect(latest(seenOnA)).toEqual(["v-a"]));
    expect(seenByOutsider).toEqual([]);
    for (const seen of [seenOnA, seenOnB]) {
      expect(seen.flatMap((u) => u.users.map((x) => x.userId))).not.toContain("outsider");
    }
  });

  it("a disconnect on B removes that user from A's viewer's list", async () => {
    const { a, b } = await twoReplicas();
    seed(["v-a", "v-b"], []);
    const seenOnA = watchThread((await connectUser(a, "v-a", open)).socket);
    const onB = await connectUser(b, "v-b", open);
    watchThread(onB.socket);
    await vi.waitFor(() => expect(latest(seenOnA)).toEqual(["v-a", "v-b"]));

    onB.socket.close();

    await vi.waitFor(() => expect(latest(seenOnA)).toEqual(["v-a"]));
  });
});
