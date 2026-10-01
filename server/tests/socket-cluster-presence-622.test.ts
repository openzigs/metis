/**
 * #622 — presence lists stay on the replica that built them once the replicas
 * share the Postgres cluster adapter.
 *
 * Each replica keeps its own in-memory presence list (`collaboration/presence.ts`)
 * and the UI (`PresenceAvatars`) replaces its whole list with every
 * `presence:update`. Relayed cluster-wide, replica A's list — which knows only
 * A's viewers — would overwrite what a viewer on B shows, and the avatars would
 * flip between partial lists. So `presence:update` is emitted locally.
 *
 * Two real Socket.IO servers with the real `@socket.io/postgres-adapter` over the
 * in-process notify bus, each with its OWN presence module instance (as two
 * processes have). Cluster-wide presence is #651.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Socket as ClientSocket } from "socket.io-client";

vi.mock("../src/lib/prisma.js", async () =>
  (await import("./helpers/two-replica-prisma.js")).prismaModuleMock(),
);

import { seed } from "./helpers/two-replica-prisma.js";
import { connectUser, startReplica, type Replica } from "./helpers/two-replica-sockets.js";
import { FakePgNotifyBus } from "./helpers/fake-pg-notify-bus.js";
import {
  createPostgresClusterAdapter,
  type SocketClusterAdapter,
} from "../src/lib/socket/cluster-adapter.js";

const ARTIFACT = { artifactType: "requirement", artifactId: "req-622" };
const ROOM = `presence:${ARTIFACT.artifactType}:${ARTIFACT.artifactId}`;

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

/** Join the artifact's presence room and record every update this client sees. */
function watch(socket: ClientSocket): PresenceUpdate[] {
  const seen: PresenceUpdate[] = [];
  socket.on("presence:update", (u: PresenceUpdate) => {
    if (u.room === ROOM) seen.push(u);
  });
  socket.emit("presence:join", ARTIFACT);
  return seen;
}

const ids = (u: PresenceUpdate) => u.users.map((x) => x.userId).sort();

describe("#622 presence lists stay local to their replica", () => {
  it("a viewer on B never receives replica A's partial list", async () => {
    const bus = new FakePgNotifyBus();
    adapters = [createPostgresClusterAdapter(bus.pool()), createPostgresClusterAdapter(bus.pool())];
    a = await startReplica(adapters[0].adapter);
    b = await startReplica(adapters[1].adapter);
    (await freshPresence()).wirePresenceHandlers(a.io);
    (await freshPresence()).wirePresenceHandlers(b.io);
    await vi.waitFor(async () => {
      expect(await a!.io.of("/").adapter.serverCount()).toBe(2);
      expect(await b!.io.of("/").adapter.serverCount()).toBe(2);
    });
    seed(["v-b1", "v-a", "v-b2"], []);

    const onB = await connectUser(b, "v-b1", open);
    const seenOnB = watch(onB.socket);
    await vi.waitFor(() => expect(seenOnB.map(ids)).toEqual([["v-b1"]]));

    // A viewer joins on A: A's list is [v-a], and A broadcasts it.
    const onA = await connectUser(a, "v-a", open);
    const seenOnA = watch(onA.socket);
    await vi.waitFor(() => expect(seenOnA.map(ids)).toEqual([["v-a"]]));

    // A second viewer on B: B's own update arrives after anything A relayed.
    const second = await connectUser(b, "v-b2", open);
    watch(second.socket);
    await vi.waitFor(() =>
      expect(seenOnB.at(-1) && ids(seenOnB.at(-1)!)).toEqual(["v-b1", "v-b2"]),
    );

    // Every list B's viewer saw was B's — never A's [v-a].
    expect(seenOnB.map(ids)).toEqual([["v-b1"], ["v-b1", "v-b2"]]);
    expect(seenOnA.map(ids)).toEqual([["v-a"]]);
  });
});
