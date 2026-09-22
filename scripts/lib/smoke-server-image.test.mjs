import { describe, expect, it, vi } from "vitest";

import {
  CONTAINER_PORT,
  DATABASES,
  DEFAULT_HOST_PORT,
  DEFAULT_POSTGRES_IMAGE,
  DEFAULT_TIMEOUT_S,
  MODULE_PROBES,
  buildRunArgs,
  parseSmokeArgs,
  runSmoke,
} from "./smoke-server-image.mjs";

/**
 * #39 — the smoke gate that makes a green `api` job mean the server image runs.
 * #45 — it runs the image against SQLite AND Postgres. #54 — its storage probes use
 * the server's own default paths. Every docker call and every HTTP poll is injected,
 * so these arms drive the gate through each way an image can fail without a daemon.
 */

/**
 * A scripted docker. `inspect` answers the server-container state poll (one entry
 * per poll, the last one repeating); `exec` answers the probes by probe name;
 * `pgReady` answers `pg_isready` (per poll, last repeats). Every answer can be keyed
 * per database arm with `byArm`.
 *
 * @param {{
 *   version?: number,
 *   run?: { status: number, stderr?: string },
 *   pgRun?: { status: number, stderr?: string },
 *   network?: number,
 *   pgReady?: number[],
 *   inspect?: string[],
 *   inspectStatus?: number,
 *   exec?: Record<string, number>,
 *   byArm?: Record<string, { inspect?: string[], exec?: Record<string, number> }>,
 * }} spec
 */
function fakeDocker(spec = {}) {
  const polls = /** @type {Record<string, number>} */ ({});
  let pgPolls = 0;
  const calls = /** @type {string[][]} */ ([]);
  /** @param {string} name */
  const armOf = (name) => (/-postgres-/.test(name) ? "postgres" : "sqlite");
  const docker = vi.fn((/** @type {string[]} */ args) => {
    calls.push(args);
    const sub = args[0];
    if (sub === "version") return { status: spec.version ?? 0, stdout: "27.0.0", stderr: "" };
    if (sub === "network" && args[1] === "create")
      return { status: spec.network ?? 0, stdout: "", stderr: spec.network ? "no network" : "" };
    if (sub === "run") {
      const isPg = args.at(-1) === DEFAULT_POSTGRES_IMAGE;
      const r = isPg ? spec.pgRun : spec.run;
      return { status: r?.status ?? 0, stdout: "cid", stderr: r?.stderr ?? "" };
    }
    if (sub === "inspect") {
      const arm = armOf(args.at(-1) ?? "");
      const states = spec.byArm?.[arm]?.inspect ?? spec.inspect ?? ["true 0"];
      const n = polls[arm] ?? 0;
      polls[arm] = n + 1;
      return {
        status: spec.inspectStatus ?? 0,
        stdout: `${states[Math.min(n, states.length - 1)]}\n`,
        stderr: "",
      };
    }
    if (sub === "exec" && args.includes("pg_isready")) {
      const seq = spec.pgReady ?? [0];
      const status = seq[Math.min(pgPolls, seq.length - 1)];
      pgPolls += 1;
      return { status, stdout: "", stderr: "" };
    }
    if (sub === "exec") {
      const arm = armOf(args[1]);
      const code = args[args.length - 1];
      const probe = MODULE_PROBES.find((p) => p.code === code);
      const table = spec.byArm?.[arm]?.exec ?? spec.exec ?? {};
      const status = table[probe?.name ?? ""] ?? 0;
      return { status, stdout: "", stderr: status === 0 ? "" : `probe ${probe?.name} blew up` };
    }
    if (sub === "logs") return { status: 0, stdout: "server log line", stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  });
  return { docker, calls };
}

/** A clock that advances by `step` ms every time it is read. */
function fakeClock(step = 1000) {
  let t = 0;
  return () => {
    t += step;
    return t;
  };
}

/** @param {Array<number | null>} statuses the /healthz status per poll; last repeats */
function fakeFetch(statuses) {
  let i = 0;
  return vi.fn(async () => {
    const s = statuses[Math.min(i, statuses.length - 1)];
    i += 1;
    return s;
  });
}

function deps(overrides = {}) {
  const out = /** @type {string[]} */ ([]);
  const errs = /** @type {string[]} */ ([]);
  return {
    out,
    errs,
    deps: {
      sleep: async () => {},
      now: fakeClock(),
      log: (/** @type {string} */ m) => out.push(m),
      err: (/** @type {string} */ m) => errs.push(m),
      secret: () => "s3cr3t",
      ...overrides,
    },
  };
}

/** @param {string[][]} calls */
const serverRuns = (calls) =>
  calls.filter((c) => c[0] === "run" && c.at(-1) !== DEFAULT_POSTGRES_IMAGE);

/** @param {string[]} args @param {string} key */
const envOf = (args, key) =>
  args
    .filter((a, i) => args[i - 1] === "--env" && a.startsWith(`${key}=`))
    .map((a) => a.slice(key.length + 1));

describe("parseSmokeArgs", () => {
  it("requires --image and applies defaults", () => {
    expect(parseSmokeArgs([])).toEqual({ error: "--image is required" });
    expect(parseSmokeArgs(["--image", "metis-server:ci-1"])).toEqual({
      image: "metis-server:ci-1",
      timeoutS: DEFAULT_TIMEOUT_S,
      port: DEFAULT_HOST_PORT,
      databases: ["sqlite", "postgres"],
      postgresImage: DEFAULT_POSTGRES_IMAGE,
    });
  });

  it("parses --timeout and --port", () => {
    expect(parseSmokeArgs(["--image", "x", "--timeout", "30", "--port", "15000"])).toEqual({
      image: "x",
      timeoutS: 30,
      port: 15000,
      databases: ["sqlite", "postgres"],
      postgresImage: DEFAULT_POSTGRES_IMAGE,
    });
  });

  it("runs BOTH databases by default, and parses --database and --postgres-image", () => {
    expect(DATABASES).toEqual(["sqlite", "postgres"]);
    const one = parseSmokeArgs([
      "--image",
      "x",
      "--database",
      "postgres",
      "--postgres-image",
      "pg:1",
    ]);
    expect(one).toMatchObject({ databases: ["postgres"], postgresImage: "pg:1" });
    expect(parseSmokeArgs(["--image", "x", "--database", "all"])).toMatchObject({
      databases: ["sqlite", "postgres"],
    });
    expect(parseSmokeArgs(["--image", "x", "--database", "mysql"])).toEqual({
      error: "--database must be one of: all, sqlite, postgres",
    });
  });

  it("rejects unknown flags, missing values and non-positive numbers", () => {
    expect(parseSmokeArgs(["--nope", "1"])).toEqual({ error: "unknown argument: --nope" });
    expect(parseSmokeArgs(["--image"])).toEqual({ error: "--image needs a value" });
    expect(parseSmokeArgs(["--image", "--port"])).toEqual({ error: "--image needs a value" });
    expect(parseSmokeArgs(["--image", "x", "--timeout", "0"])).toEqual({
      error: "--timeout must be a positive integer",
    });
    expect(parseSmokeArgs(["--image", "x", "--port", "1.5"])).toEqual({
      error: "--port must be a positive integer",
    });
  });
});

describe("buildRunArgs", () => {
  const args = buildRunArgs({
    image: "metis-server:ci-1",
    name: "smoke",
    port: 14000,
    jwtSecret: "j",
    vaultKey: "v",
    embeddingsToken: "e",
  });

  it("runs the image's own CMD: the image is the last argument, nothing follows it", () => {
    expect(args[0]).toBe("run");
    expect(args.at(-1)).toBe("metis-server:ci-1");
  });

  it("publishes only on loopback, to the port the image listens on", () => {
    expect(args).toContain(`127.0.0.1:14000:${CONTAINER_PORT}`);
  });

  it("passes the per-run secrets and a production-legal auth mode", () => {
    expect(args).toContain("JWT_SECRET=j");
    expect(args).toContain("VAULT_MASTER_KEY=v");
    expect(args).toContain("EMBEDDINGS_TOKEN=e");
    expect(args).toContain("AUTH_MODE=ldap");
    expect(args).not.toContain("AUTH_MODE=mock");
  });

  it("does not skip the migration guard — the boot path under test includes it", () => {
    expect(args.join(" ")).not.toMatch(/METIS_SKIP_MIGRATE/);
  });

  it("sets no DATABASE_URL by default, so the SQLite arm boots the server's OWN default (#54)", () => {
    expect(envOf(args, "DATABASE_URL")).toEqual([]);
    expect(args).not.toContain("--network");
  });

  it("joins the network and passes the Postgres URL when given (#45)", () => {
    const pg = buildRunArgs({
      image: "img",
      name: "smoke",
      port: 14000,
      jwtSecret: "j",
      vaultKey: "v",
      embeddingsToken: "e",
      network: "net-1",
      databaseUrl: "postgresql://metis:pw@pg-1:5432/metis",
    });
    expect(pg[pg.indexOf("--network") + 1]).toBe("net-1");
    expect(envOf(pg, "DATABASE_URL")).toEqual(["postgresql://metis:pw@pg-1:5432/metis"]);
    expect(pg.at(-1)).toBe("img");
  });
});

describe("MODULE_PROBES", () => {
  /** @param {string} name */
  const code = (name) => MODULE_PROBES.find((p) => p.name === name)?.code ?? "";

  it("probes storage through the server's own code, never a scratch path (#54)", () => {
    expect(code("lancedb")).toContain("/app/server/dist/lib/rag/vector-store.js");
    expect(code("lancedb")).toContain("getVectorStore()");
    expect(code("uploads")).toContain("/app/server/dist/lib/documents/storage.js");
    expect(code("uploads")).toContain("resolveDocumentStorage()");
    for (const p of MODULE_PROBES) expect(p.code).not.toMatch(/\/tmp\b/);
  });

  it("reads back what the storage probes wrote", () => {
    expect(code("lancedb")).toMatch(/vs\.count\(p\)/);
    expect(code("uploads")).toMatch(/s\.read\(b\.storagePath\)/);
  });

  it("queries a migrated table through the server's own Prisma client, and checks migrate status (#45)", () => {
    expect(code("database")).toContain("/app/server/dist/lib/prisma.js");
    expect(code("database")).toMatch(/prisma\.user\.count\(\)/);
    expect(code("migrations")).toMatch(/"migrate", "status"/);
  });
});

describe("runSmoke", () => {
  it("passes when both arms serve /healthz and pass every probe", async () => {
    const { docker, calls } = fakeDocker();
    const { deps: d, out } = deps({ docker, fetchStatus: fakeFetch([null, 503, 200]) });
    expect(await runSmoke({ image: "img", pollMs: 1 }, d)).toBe(0);
    expect(out).toContain(
      `PASS: [sqlite] img starts, serves /healthz and passes ${MODULE_PROBES.length} probe(s)`,
    );
    expect(out).toContain(
      `PASS: [postgres] img starts, serves /healthz and passes ${MODULE_PROBES.length} probe(s)`,
    );
    expect(out.at(-1)).toBe("PASS: img serves sqlite and postgres");
    const probeExecs = calls.filter((c) => c[0] === "exec" && !c.includes("pg_isready"));
    expect(probeExecs).toHaveLength(2 * MODULE_PROBES.length);
    // Probes run in the image's WORKDIR — the server's cwd — not a pinned one.
    expect(probeExecs.some((c) => c.includes("--workdir"))).toBe(false);
  });

  it("boots SQLite on the server's default and Postgres on a live container on a private network", async () => {
    const { docker, calls } = fakeDocker();
    const { deps: d } = deps({ docker, fetchStatus: fakeFetch([200]) });
    await runSmoke({ image: "img", pollMs: 1 }, d);
    const [sqlite, postgres] = serverRuns(calls);
    expect(envOf(sqlite, "DATABASE_URL")).toEqual([]);
    const [url] = envOf(postgres, "DATABASE_URL");
    const pgRun = calls.find((c) => c[0] === "run" && c.at(-1) === DEFAULT_POSTGRES_IMAGE) ?? [];
    const pgName = pgRun[pgRun.indexOf("--name") + 1];
    const net = calls.find((c) => c[0] === "network" && c[1] === "create")?.[2];
    expect(url).toBe(`postgresql://metis:s3cr3t@${pgName}:5432/metis`);
    expect(pgRun[pgRun.indexOf("--network") + 1]).toBe(net);
    expect(postgres[postgres.indexOf("--network") + 1]).toBe(net);
    // Postgres was ready before the server started.
    expect(calls.findIndex((c) => c.includes("pg_isready"))).toBeLessThan(calls.indexOf(postgres));
  });

  it("removes the server, then Postgres, then the network, on the Postgres arm", async () => {
    const { docker, calls } = fakeDocker();
    const { deps: d } = deps({ docker, fetchStatus: fakeFetch([200]) });
    await runSmoke({ image: "img", pollMs: 1, databases: ["postgres"] }, d);
    const tail = calls.slice(-3).map((c) => `${c[0]} ${c[1]} ${c[2] ?? ""}`);
    expect(tail[0]).toMatch(/^rm --force metis-smoke-postgres-/);
    expect(tail[1]).toMatch(/^rm --force metis-smoke-pg-/);
    expect(tail[2]).toMatch(/^network rm metis-smoke-net-/);
  });

  it("fails the Postgres arm when the server exits at import — the #45 shape — and still runs SQLite", async () => {
    const { docker, calls } = fakeDocker({ byArm: { postgres: { inspect: ["false 1"] } } });
    const { deps: d, errs, out } = deps({ docker, fetchStatus: fakeFetch([200]) });
    expect(await runSmoke({ image: "img", pollMs: 1 }, d)).toBe(1);
    expect(errs.join("\n")).toMatch(
      /\[postgres\] img exited before serving \/healthz \(exit code 1\)/,
    );
    expect(errs.join("\n")).toContain("server log line");
    expect(out.some((m) => m.startsWith("PASS: [sqlite]"))).toBe(true);
    expect(errs.at(-1)).toBe("FAIL: img failed on: postgres");
    expect(calls.at(-1)?.slice(0, 2)).toEqual(["network", "rm"]);
  });

  it("fails when Postgres never becomes ready, without starting the server", async () => {
    const { docker, calls } = fakeDocker({ pgReady: [1] });
    const { deps: d, errs } = deps({ docker, fetchStatus: fakeFetch([200]) });
    expect(
      await runSmoke({ image: "img", timeoutS: 3, pollMs: 1, databases: ["postgres"] }, d),
    ).toBe(1);
    expect(errs.join("\n")).toMatch(/did not accept connections within 3s/);
    expect(serverRuns(calls)).toHaveLength(0);
    expect(calls.at(-1)?.slice(0, 2)).toEqual(["network", "rm"]);
  });

  it("waits for Postgres through its init restart", async () => {
    const { docker, calls } = fakeDocker({ pgReady: [2, 2, 0] });
    const { deps: d } = deps({ docker, fetchStatus: fakeFetch([200]) });
    expect(await runSmoke({ image: "img", pollMs: 1, databases: ["postgres"] }, d)).toBe(0);
    expect(calls.filter((c) => c.includes("pg_isready"))).toHaveLength(3);
  });

  it("fails when the Postgres container or its network cannot be created", async () => {
    for (const spec of [{ pgRun: { status: 125, stderr: "pull denied" } }, { network: 1 }]) {
      const { docker, calls } = fakeDocker(spec);
      const { deps: d, errs } = deps({ docker, fetchStatus: fakeFetch([200]) });
      expect(await runSmoke({ image: "img", pollMs: 1, databases: ["postgres"] }, d)).toBe(1);
      expect(errs.join("\n")).toMatch(/FAIL: could not (start|create)/);
      expect(serverRuns(calls)).toHaveLength(0);
    }
  });

  it("fails and prints the log when the container exits before serving (the #39 shape)", async () => {
    const { docker, calls } = fakeDocker({ inspect: ["true 0", "false 1"] });
    const fetchStatus = fakeFetch([null]);
    const { deps: d, errs } = deps({ docker, fetchStatus });
    expect(await runSmoke({ image: "img", pollMs: 1, databases: ["sqlite"] }, d)).toBe(1);
    expect(errs.join("\n")).toMatch(/exited before serving \/healthz \(exit code 1\)/);
    expect(errs.join("\n")).toContain("server log line");
    expect(calls.some((c) => c[0] === "exec")).toBe(false);
    expect(calls.at(-1)?.slice(0, 2)).toEqual(["rm", "--force"]);
  });

  it("fails when inspect itself fails (container already gone)", async () => {
    const { docker } = fakeDocker({ inspectStatus: 1, inspect: [""] });
    const { deps: d, errs } = deps({ docker, fetchStatus: fakeFetch([200]) });
    expect(await runSmoke({ image: "img", pollMs: 1 }, d)).toBe(1);
    expect(errs.join("\n")).toMatch(/exited before serving/);
  });

  it("fails when /healthz never answers 200 within the deadline", async () => {
    const { docker } = fakeDocker();
    const { deps: d, errs } = deps({ docker, fetchStatus: fakeFetch([503]) });
    expect(await runSmoke({ image: "img", timeoutS: 5, pollMs: 1, databases: ["sqlite"] }, d)).toBe(
      1,
    );
    expect(errs.join("\n")).toMatch(/did not return 200 within 5s \(last status: 503\)/);
    expect(errs.join("\n")).toContain("server log line");
  });

  it("reports 'no response' when nothing ever answered", async () => {
    const { docker } = fakeDocker();
    const { deps: d, errs } = deps({ docker, fetchStatus: fakeFetch([null]) });
    expect(await runSmoke({ image: "img", timeoutS: 3, pollMs: 1, databases: ["sqlite"] }, d)).toBe(
      1,
    );
    expect(errs.join("\n")).toMatch(/last status: no response/);
  });

  it("fails when /healthz is up but a storage probe fails (the #54 shape)", async () => {
    const { docker } = fakeDocker({ byArm: { sqlite: { exec: { lancedb: 1 } } } });
    const { deps: d, errs, out } = deps({ docker, fetchStatus: fakeFetch([200]) });
    expect(await runSmoke({ image: "img", pollMs: 1 }, d)).toBe(1);
    expect(out).toContain("OK: [sqlite] /healthz returned 200");
    expect(errs.join("\n")).toMatch(
      new RegExp(`\\[sqlite\\] 1 of ${MODULE_PROBES.length} probe\\(s\\) failed: lancedb`),
    );
    expect(errs.join("\n")).toContain("probe lancedb blew up");
    expect(errs.at(-1)).toBe("FAIL: img failed on: sqlite");
  });

  it("fails when docker run cannot start the container", async () => {
    const { docker, calls } = fakeDocker({ run: { status: 125, stderr: "no such image" } });
    const { deps: d, errs } = deps({ docker, fetchStatus: fakeFetch([200]) });
    expect(await runSmoke({ image: "img", pollMs: 1, databases: ["sqlite"] }, d)).toBe(1);
    expect(errs.join("\n")).toMatch(/docker run did not start the container: no such image/);
    expect(calls.at(-1)?.slice(0, 2)).toEqual(["rm", "--force"]);
  });

  it("exits 2 (invocation error, not a verdict) when docker is unavailable", async () => {
    const { docker, calls } = fakeDocker({ version: 1 });
    const { deps: d } = deps({ docker, fetchStatus: fakeFetch([200]) });
    expect(await runSmoke({ image: "img" }, d)).toBe(2);
    expect(calls.some((c) => c[0] === "run")).toBe(false);
  });

  it("never logs the generated secrets, including the Postgres password", async () => {
    const { docker } = fakeDocker({ inspect: ["false 1"] });
    const { deps: d, out, errs } = deps({ docker, fetchStatus: fakeFetch([null]) });
    await runSmoke({ image: "img", pollMs: 1 }, d);
    expect([...out, ...errs].join("\n")).not.toContain("s3cr3t");
  });
});
