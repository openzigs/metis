/**
 * #674 — `subscribe:job` for a job with no row, on a replica that did not
 * start it.
 *
 * Since #655 a `job:{id}` join is authorized against the job's scope. For
 * repo ingest, spec-kit, overview regenerate, embeddings reindex and PR review
 * that scope lived only in the memory of the process that handed out the id,
 * so a member whose socket sits on another replica was refused and never saw
 * the job's events. The trigger routes now await `recordJobScope`, which writes
 * a durable record before the id leaves the server.
 *
 * Two real Socket.IO servers share the real `@socket.io/postgres-adapter` over
 * the in-process notify bus, and one Prisma mock (the "database"). The replicas
 * share a module graph, so the in-process scope store is cleared after A records
 * the scope: that is what B — a separate process — would hold. Server vitest has
 * `retry: 2`, so every fixture is created per attempt.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Socket as ClientSocket } from "socket.io-client";
import type { JobLifecycleEvent } from "@metis/shared";

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
import { registerSocketServer } from "../src/lib/socket/registry.js";
import { recordJobScope } from "../src/lib/socket/job-scope-store.js";
import {
  _resetJobLifecycleMemory,
  jobEvents,
  rememberJobScope,
} from "../src/lib/socket/job-events.js";

const WS = "ws-674";
const PROJECT = "p-674";

let a: Replica;
let b: Replica;
let adapters: SocketClusterAdapter[] = [];
const open: ClientSocket[] = [];

async function startClusteredPair(): Promise<void> {
  const bus = new FakePgNotifyBus();
  adapters = [createPostgresClusterAdapter(bus.pool()), createPostgresClusterAdapter(bus.pool())];
  a = await startReplica(adapters[0].adapter);
  b = await startReplica(adapters[1].adapter);
  // The trigger routes run on A: `getSocketServer()` is A's server.
  registerSocketServer(a.io);
  await vi.waitFor(async () => {
    expect(await a.io.of("/").adapter.serverCount()).toBe(2);
    expect(await b.io.of("/").adapter.serverCount()).toBe(2);
  });
  seed(["u-member", "u-outsider"], [[WS, "u-member"]], [[PROJECT, WS]]);
}

type SubscribeAck = { joined: boolean; error?: string };

/** `subscribe:job` on `socket`, answered by `auth:error` (refused) or the join. */
async function subscribeJob(
  replica: Replica,
  socket: ClientSocket,
  jobId: string,
): Promise<SubscribeAck> {
  const refused = new Promise<SubscribeAck>((resolve) =>
    socket.once("auth:error", (e: { message: string }) =>
      resolve({ joined: false, error: e.message }),
    ),
  );
  socket.emit("subscribe:job", { jobId });
  const joined = vi
    .waitFor(() => expect(replica.roomHas(`job:${jobId}`, socket.id!)).toBe(true), {
      timeout: 2000,
    })
    .then((): SubscribeAck => ({ joined: true }));
  return Promise.race([refused, joined]);
}

afterEach(async () => {
  for (const s of open.splice(0)) s.close();
  _resetJobLifecycleMemory();
  registerSocketServer(null as never);
  await a?.close();
  await b?.close();
  await Promise.all(adapters.map((x) => x.close()));
  adapters = [];
});

describe("#674 — a row-less job's room on a replica that did not start it", () => {
  it("joins a member on B to a job A recorded, and refuses a non-member", async () => {
    await startClusteredPair();
    // On A: the trigger route records the scope, then hands the id out.
    await recordJobScope("ingest-1", "repo-ingest", PROJECT);
    // B is another process: it remembers nothing A did.
    _resetJobLifecycleMemory();

    const member = await connectUser(b, "u-member", open);
    const outsider = await connectUser(b, "u-outsider", open);
    expect(await subscribeJob(b, member.socket, "ingest-1")).toEqual({ joined: true });
    expect(await subscribeJob(b, outsider.socket, "ingest-1")).toEqual({
      joined: false,
      error: "FORBIDDEN: no access to job",
    });
  });

  it("delivers A's events to a member who subscribed on B before the job's first event", async () => {
    await startClusteredPair();
    await recordJobScope("spec-1", "spec-kit", PROJECT);
    _resetJobLifecycleMemory();

    // The client subscribes the moment it has the id — before A emits anything.
    const member = await connectUser(b, "u-member", open);
    expect(await subscribeJob(b, member.socket, "spec-1")).toEqual({ joined: true });

    const received = new Promise<JobLifecycleEvent>((resolve) =>
      member.socket.on("job:lifecycle", (e: JobLifecycleEvent) => {
        if (e.jobId === "spec-1") resolve(e);
      }),
    );
    jobEvents.started("spec-kit", "spec-1", PROJECT, "Running /specify");
    expect(await received).toMatchObject({ jobId: "spec-1", status: "started" });
  });

  it("refuses on B a job whose scope A held only in memory (the pre-#674 shape)", async () => {
    await startClusteredPair();
    rememberJobScope("mem-only", "pr-review", PROJECT);
    _resetJobLifecycleMemory();

    const member = await connectUser(b, "u-member", open);
    expect(await subscribeJob(b, member.socket, "mem-only")).toEqual({
      joined: false,
      error: "FORBIDDEN: no access to job",
    });
  });
});
