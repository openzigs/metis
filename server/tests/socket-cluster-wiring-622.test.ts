/**
 * #622 — the production boot path installs the Socket.IO cluster adapter.
 *
 * The unit suite runs under `NODE_ENV=test`, where the adapter is never
 * selected, so a test that only builds servers by hand stays green if the
 * selection or the wiring is deleted. This pins both: `bootServer`, given a
 * production env with a Postgres URL, builds the real server on the real adapter
 * (the pool comes from the in-process notify bus), and given the test env builds
 * it on the in-memory adapter with no pool.
 *
 * It does NOT pin that `index.ts` calls `bootServer`: that block runs only when
 * `METIS_NO_LISTEN !== "1"`, which `tests/setup.ts` sets, so reverting it to
 * `createServer()` leaves this suite green. That revert, and any other production
 * boot that stops attaching the adapter, is caught by the CI image smoke test's
 * `socket-cluster` probe (#650, scripts/lib/smoke-server-image.mjs), which boots
 * the built image on Postgres with NODE_ENV=production and asks Postgres whether
 * the adapter's `LISTEN` connection exists.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakePgNotifyBus } from "./helpers/fake-pg-notify-bus.js";
import { bootServer, createServer, type MetisServer } from "../src/server.js";
import { createPostgresClusterAdapter } from "../src/lib/socket/cluster-adapter.js";

const PG_URL = "postgres://u:p@db:5432/metis";
let server: MetisServer | undefined;

afterEach(async () => {
  await server?.io.close();
  await server?.socketCluster?.close();
  server = undefined;
});

/** The adapter class the default namespace was built on. */
const adapterName = (s: MetisServer) => s.io.of("/").adapter.constructor.name;

describe("#622 bootServer selects and installs the cluster adapter", () => {
  it("installs the Postgres adapter for a production Postgres datasource", async () => {
    const bus = new FakePgNotifyBus();
    const makePool = vi.fn(() => bus.pool());

    server = await bootServer(
      { skipMCPBootstrap: true },
      { NODE_ENV: "production", DATABASE_URL: PG_URL },
      makePool,
    );

    expect(makePool).toHaveBeenCalledWith(PG_URL);
    expect(server.socketCluster).not.toBeNull();
    expect(adapterName(server)).toBe("PostgresAdapter");
    // The installed adapter is live: it has taken its LISTEN client.
    await vi.waitFor(() => expect(bus.clients.size).toBe(1));
  });

  it("keeps the in-memory adapter, with no pool, under NODE_ENV=test", async () => {
    const makePool = vi.fn();
    server = await bootServer(
      { skipMCPBootstrap: true },
      { NODE_ENV: "test", DATABASE_URL: PG_URL },
      makePool,
    );
    expect(makePool).not.toHaveBeenCalled();
    expect(server.socketCluster).toBeNull();
    // socket.io's default in-memory adapter.
    expect(adapterName(server)).toBe("Adapter");
  });

  it("createServer installs the cluster adapter it is given", () => {
    const cluster = createPostgresClusterAdapter(new FakePgNotifyBus().pool());
    server = createServer({ skipMCPBootstrap: true, socketCluster: cluster });
    expect(server.socketCluster).toBe(cluster);
    expect(adapterName(server)).toBe("PostgresAdapter");
  });

  it("#649 createServer re-validates its sockets when the adapter's LISTEN connection is (re)established", () => {
    const cluster = createPostgresClusterAdapter(new FakePgNotifyBus().pool());
    const onListening = vi.spyOn(cluster, "onListening");
    server = createServer({ skipMCPBootstrap: true, socketCluster: cluster });
    expect(onListening).toHaveBeenCalledTimes(1);
    expect(onListening).toHaveBeenCalledWith(expect.any(Function));
  });
});
