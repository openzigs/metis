import { describe, expect, it, vi } from "vitest";

import {
  ARMS,
  CONTAINER_PORT,
  DEFAULT_HOST_PORT,
  DEFAULT_POSTGRES_IMAGE,
  DEFAULT_TIMEOUT_S,
  HELM_DEFAULT_WRITABLE_PATHS,
  HELM_RUN_AS,
  MODULE_PROBES,
  POSTGRES_ARM_BACKENDS,
  buildRunArgs,
  parseSmokeArgs,
  runSmoke,
} from "./smoke-server-image.mjs";

/**
 * #39 — the smoke gate that makes a green `api` job mean the server image runs.
 * #45 — it runs the image against SQLite AND Postgres. #54 — its storage probes use
 * the server's own default paths. #60 — Postgres runs pgvector, and a third arm runs
 * the Helm chart's default values. #51 — no secret on docker's command line.
 * Every docker call and every HTTP poll is injected,
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
  const envs = /** @type {Array<Record<string, string> | undefined>} */ ([]);
  /** @param {string} name */
  const armOf = (name) => ARMS.find((a) => name.startsWith(`metis-smoke-${a}-`)) ?? "sqlite";
  const docker = vi.fn(
    (/** @type {string[]} */ args, /** @type {Record<string, string>=} */ env) => {
      calls.push(args);
      envs.push(env);
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
    },
  );
  return { docker, calls, envs };
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

/** @param {string[]} args @param {string} key — `--env KEY=value` values in argv */
const envOf = (args, key) =>
  args
    .filter((a, i) => args[i - 1] === "--env" && a.startsWith(`${key}=`))
    .map((a) => a.slice(key.length + 1));

/** @param {string[]} args @param {string} key — `--env KEY` (value from docker's env) */
const namesEnv = (args, key) => args.some((a, i) => args[i - 1] === "--env" && a === key);

/** @param {string[][]} calls @param {string} arm */
const serverRunOf = (calls, arm) =>
  serverRuns(calls).find((c) => c[c.indexOf("--name") + 1].startsWith(`metis-smoke-${arm}-`)) ?? [];

/** @param {string} arm */
const probesFor = (arm) => MODULE_PROBES.filter((p) => !p.arms || p.arms.includes(arm));

describe("parseSmokeArgs", () => {
  it("requires --image and applies defaults", () => {
    expect(parseSmokeArgs([])).toEqual({ error: "--image is required" });
    expect(parseSmokeArgs(["--image", "metis-server:ci-1"])).toEqual({
      image: "metis-server:ci-1",
      timeoutS: DEFAULT_TIMEOUT_S,
      port: DEFAULT_HOST_PORT,
      arms: ["sqlite", "postgres", "helm-default"],
      postgresImage: DEFAULT_POSTGRES_IMAGE,
    });
  });

  it("parses --timeout and --port", () => {
    expect(parseSmokeArgs(["--image", "x", "--timeout", "30", "--port", "15000"])).toEqual({
      image: "x",
      timeoutS: 30,
      port: 15000,
      arms: ["sqlite", "postgres", "helm-default"],
      postgresImage: DEFAULT_POSTGRES_IMAGE,
    });
  });

  it("runs EVERY arm by default, and parses --arm and --postgres-image", () => {
    expect(ARMS).toEqual(["sqlite", "postgres", "helm-default"]);
    const one = parseSmokeArgs(["--image", "x", "--arm", "postgres", "--postgres-image", "pg:1"]);
    expect(one).toMatchObject({ arms: ["postgres"], postgresImage: "pg:1" });
    expect(parseSmokeArgs(["--image", "x", "--arm", "helm-default"])).toMatchObject({
      arms: ["helm-default"],
    });
    expect(parseSmokeArgs(["--image", "x", "--arm", "all"])).toMatchObject({
      arms: ["sqlite", "postgres", "helm-default"],
    });
    expect(parseSmokeArgs(["--image", "x", "--arm", "mysql"])).toEqual({
      error: "--arm must be one of: all, sqlite, postgres, helm-default",
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
  const { args, env } = buildRunArgs({
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
    expect(env).toEqual({ JWT_SECRET: "j", VAULT_MASTER_KEY: "v", EMBEDDINGS_TOKEN: "e" });
    for (const k of Object.keys(env)) expect(namesEnv(args, k)).toBe(true);
    expect(args).toContain("AUTH_MODE=ldap");
    expect(args).not.toContain("AUTH_MODE=mock");
  });

  it("never puts a secret value on docker's command line, where `ps` shows it (#51)", () => {
    for (const a of args) {
      expect(a).not.toMatch(/^(JWT_SECRET|VAULT_MASTER_KEY|EMBEDDINGS_TOKEN|DATABASE_URL)=/);
    }
    const pg = buildRunArgs({
      image: "img",
      name: "smoke",
      port: 14000,
      jwtSecret: "jj-secret",
      vaultKey: "vv-secret",
      embeddingsToken: "ee-secret",
      databaseUrl: "postgresql://metis:pw-secret@pg-1:5432/metis",
    });
    expect(pg.args.join(" ")).not.toMatch(/-secret/);
  });

  it("does not skip the migration guard — the boot path under test includes it", () => {
    expect(args.join(" ")).not.toMatch(/METIS_SKIP_MIGRATE/);
  });

  it("sets no DATABASE_URL by default, so the SQLite arm boots the image's OWN default (#54)", () => {
    expect(envOf(args, "DATABASE_URL")).toEqual([]);
    expect(namesEnv(args, "DATABASE_URL")).toBe(false);
    expect(env.DATABASE_URL).toBeUndefined();
    expect(args).not.toContain("--network");
  });

  it("joins the network and passes the Postgres URL, through docker's env, when given (#45)", () => {
    const pg = buildRunArgs({
      image: "img",
      name: "smoke",
      port: 14000,
      jwtSecret: "j",
      vaultKey: "v",
      embeddingsToken: "e",
      network: "net-1",
      databaseUrl: "postgresql://metis:pw@pg-1:5432/metis",
      backends: POSTGRES_ARM_BACKENDS,
    });
    expect(pg.args[pg.args.indexOf("--network") + 1]).toBe("net-1");
    expect(namesEnv(pg.args, "DATABASE_URL")).toBe(true);
    expect(pg.env.DATABASE_URL).toBe("postgresql://metis:pw@pg-1:5432/metis");
    expect(envOf(pg.args, "VECTOR_STORE")).toEqual(["pgvector"]);
    expect(pg.args.at(-1)).toBe("img");
  });

  it("applies no container hardening outside the helm-default arm", () => {
    expect(args).not.toContain("--read-only");
    expect(args).not.toContain("--tmpfs");
    expect(args).not.toContain("--user");
    expect(envOf(args, "VECTOR_STORE")).toEqual([]);
  });

  it("runs the Helm chart's default container constraints for helm-default (#60)", () => {
    const h = buildRunArgs({
      image: "img",
      name: "smoke",
      port: 14000,
      jwtSecret: "j",
      vaultKey: "v",
      embeddingsToken: "e",
      helmDefault: true,
    }).args;
    expect(h).toContain("--read-only");
    expect(h[h.indexOf("--user") + 1]).toBe(HELM_RUN_AS);
    expect(h[h.indexOf("--cap-drop") + 1]).toBe("ALL");
    expect(h[h.indexOf("--security-opt") + 1]).toBe("no-new-privileges");
    const tmpfs = h.filter((_, i) => h[i - 1] === "--tmpfs").map((t) => t.split(":")[0]);
    expect(tmpfs).toEqual([...HELM_DEFAULT_WRITABLE_PATHS]);
    // The chart's default sets no DATABASE_URL: the image's own SQLite default boots.
    expect(namesEnv(h, "DATABASE_URL")).toBe(false);
    expect(h.at(-1)).toBe("img");
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

  it("finds the Prisma CLI through the package's declared bin, not build/index.js (#51)", () => {
    expect(code("migrations")).toContain('resolve("prisma/package.json")');
    expect(code("migrations")).toMatch(/\.bin\b/);
    expect(code("migrations")).not.toContain("prisma/build/index.js");
  });

  it("probes the production vector store on Postgres: write, search and read back (#60)", () => {
    const pg = MODULE_PROBES.find((p) => p.name === "pgvector");
    expect(pg?.arms).toEqual(["postgres"]);
    expect(code("pgvector")).toContain("/app/server/dist/lib/rag/vector-store-pgvector.js");
    expect(code("pgvector")).toContain("registerPgVectorStore()");
    expect(code("pgvector")).toContain('"PgVectorStore"');
    expect(code("pgvector")).toMatch(/vs\.search\(p, v, 1\)/);
    expect(code("pgvector")).toMatch(/vs\.count\(p\)/);
  });

  it("runs LanceDB where LanceDB is the store, and every other probe in every arm", () => {
    expect(probesFor("postgres").map((p) => p.name)).not.toContain("lancedb");
    expect(probesFor("sqlite").map((p) => p.name)).toContain("lancedb");
    expect(probesFor("helm-default").map((p) => p.name)).toContain("lancedb");
    expect(probesFor("sqlite").map((p) => p.name)).not.toContain("pgvector");
    for (const arm of ARMS) {
      for (const name of ["database", "migrations", "uploads", "home-writable", "oracle-thick"]) {
        expect(probesFor(arm).map((p) => p.name)).toContain(name);
      }
    }
  });
});

describe("runSmoke", () => {
  it("passes when every arm serves /healthz and passes its probes", async () => {
    const { docker, calls } = fakeDocker();
    const { deps: d, out } = deps({ docker, fetchStatus: fakeFetch([null, 503, 200]) });
    expect(await runSmoke({ image: "img", pollMs: 1 }, d)).toBe(0);
    for (const arm of ARMS) {
      expect(out).toContain(
        `PASS: [${arm}] img starts, serves /healthz and passes ${probesFor(arm).length} probe(s)`,
      );
    }
    expect(out.at(-1)).toBe("PASS: img passes every arm: sqlite, postgres, helm-default");
    const probeExecs = calls.filter((c) => c[0] === "exec" && !c.includes("pg_isready"));
    expect(probeExecs).toHaveLength(ARMS.reduce((n, a) => n + probesFor(a).length, 0));
    // Probes run in the image's WORKDIR — the server's cwd — not a pinned one.
    expect(probeExecs.some((c) => c.includes("--workdir"))).toBe(false);
  });

  it("boots SQLite on the image's default and Postgres on a live container on a private network", async () => {
    const { docker, calls, envs } = fakeDocker();
    const { deps: d } = deps({ docker, fetchStatus: fakeFetch([200]) });
    await runSmoke({ image: "img", pollMs: 1 }, d);
    const sqlite = serverRunOf(calls, "sqlite");
    const postgres = serverRunOf(calls, "postgres");
    expect(namesEnv(sqlite, "DATABASE_URL")).toBe(false);
    expect(namesEnv(postgres, "DATABASE_URL")).toBe(true);
    const url = envs[calls.indexOf(postgres)]?.DATABASE_URL;
    const pgRun = calls.find((c) => c[0] === "run" && c.at(-1) === DEFAULT_POSTGRES_IMAGE) ?? [];
    const pgName = pgRun[pgRun.indexOf("--name") + 1];
    const net = calls.find((c) => c[0] === "network" && c[1] === "create")?.[2];
    expect(url).toBe(`postgresql://metis:s3cr3t@${pgName}:5432/metis`);
    // The password Postgres was started with is the one in the URL, and neither is on argv.
    expect(namesEnv(pgRun, "POSTGRES_PASSWORD")).toBe(true);
    expect(envs[calls.indexOf(pgRun)]).toEqual({ POSTGRES_PASSWORD: "s3cr3t" });
    // #60 — Postgres runs production's shared backends; SQLite keeps the defaults.
    for (const [k, v] of Object.entries(POSTGRES_ARM_BACKENDS)) {
      expect(envOf(postgres, k)).toEqual([v]);
      expect(envOf(sqlite, k)).toEqual([]);
    }
    expect(pgRun[pgRun.indexOf("--network") + 1]).toBe(net);
    expect(postgres[postgres.indexOf("--network") + 1]).toBe(net);
    // Postgres was ready before the server started.
    expect(calls.findIndex((c) => c.includes("pg_isready"))).toBeLessThan(calls.indexOf(postgres));
  });

  it("removes the server, then Postgres, then the network, on the Postgres arm", async () => {
    const { docker, calls } = fakeDocker();
    const { deps: d } = deps({ docker, fetchStatus: fakeFetch([200]) });
    await runSmoke({ image: "img", pollMs: 1, arms: ["postgres"] }, d);
    const tail = calls.slice(-3).map((c) => `${c[0]} ${c[1]} ${c[2] ?? ""}`);
    expect(tail[0]).toMatch(/^rm --force metis-smoke-postgres-/);
    expect(tail[1]).toMatch(/^rm --force metis-smoke-pg-/);
    expect(tail[2]).toMatch(/^network rm metis-smoke-net-/);
  });

  it("fails the Postgres arm when the server exits at import — the #45 shape — and still runs SQLite", async () => {
    const { docker, calls } = fakeDocker({ byArm: { postgres: { inspect: ["false 1"] } } });
    const { deps: d, errs, out } = deps({ docker, fetchStatus: fakeFetch([200]) });
    expect(await runSmoke({ image: "img", pollMs: 1, arms: ["sqlite", "postgres"] }, d)).toBe(1);
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
    expect(await runSmoke({ image: "img", timeoutS: 3, pollMs: 1, arms: ["postgres"] }, d)).toBe(1);
    expect(errs.join("\n")).toMatch(/did not accept connections within 3s/);
    expect(serverRuns(calls)).toHaveLength(0);
    expect(calls.at(-1)?.slice(0, 2)).toEqual(["network", "rm"]);
  });

  it("waits for Postgres through its init restart", async () => {
    const { docker, calls } = fakeDocker({ pgReady: [2, 2, 0] });
    const { deps: d } = deps({ docker, fetchStatus: fakeFetch([200]) });
    expect(await runSmoke({ image: "img", pollMs: 1, arms: ["postgres"] }, d)).toBe(0);
    expect(calls.filter((c) => c.includes("pg_isready"))).toHaveLength(3);
  });

  it("fails when the Postgres container or its network cannot be created", async () => {
    for (const spec of [{ pgRun: { status: 125, stderr: "pull denied" } }, { network: 1 }]) {
      const { docker, calls } = fakeDocker(spec);
      const { deps: d, errs } = deps({ docker, fetchStatus: fakeFetch([200]) });
      expect(await runSmoke({ image: "img", pollMs: 1, arms: ["postgres"] }, d)).toBe(1);
      expect(errs.join("\n")).toMatch(/FAIL: could not (start|create)/);
      expect(serverRuns(calls)).toHaveLength(0);
    }
  });

  it("fails and prints the log when the container exits before serving (the #39 shape)", async () => {
    const { docker, calls } = fakeDocker({ inspect: ["true 0", "false 1"] });
    const fetchStatus = fakeFetch([null]);
    const { deps: d, errs } = deps({ docker, fetchStatus });
    expect(await runSmoke({ image: "img", pollMs: 1, arms: ["sqlite"] }, d)).toBe(1);
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
    expect(await runSmoke({ image: "img", timeoutS: 5, pollMs: 1, arms: ["sqlite"] }, d)).toBe(1);
    expect(errs.join("\n")).toMatch(/did not return 200 within 5s \(last status: 503\)/);
    expect(errs.join("\n")).toContain("server log line");
  });

  it("reports 'no response' when nothing ever answered", async () => {
    const { docker } = fakeDocker();
    const { deps: d, errs } = deps({ docker, fetchStatus: fakeFetch([null]) });
    expect(await runSmoke({ image: "img", timeoutS: 3, pollMs: 1, arms: ["sqlite"] }, d)).toBe(1);
    expect(errs.join("\n")).toMatch(/last status: no response/);
  });

  it("fails the helm-default arm when the image cannot boot under the chart's defaults (#60)", async () => {
    const { docker, calls } = fakeDocker({ byArm: { "helm-default": { inspect: ["false 1"] } } });
    const { deps: d, errs, out } = deps({ docker, fetchStatus: fakeFetch([200]) });
    expect(await runSmoke({ image: "img", pollMs: 1 }, d)).toBe(1);
    expect(errs.join("\n")).toMatch(/\[helm-default\] img exited before serving \/healthz/);
    expect(out.some((m) => m.startsWith("PASS: [sqlite]"))).toBe(true);
    expect(out.some((m) => m.startsWith("PASS: [postgres]"))).toBe(true);
    expect(errs.at(-1)).toBe("FAIL: img failed on: helm-default");
    expect(serverRunOf(calls, "helm-default")).toContain("--read-only");
  });

  it("fails the Postgres arm when the pgvector probe fails (#60)", async () => {
    const { docker } = fakeDocker({ byArm: { postgres: { exec: { pgvector: 1 } } } });
    const { deps: d, errs } = deps({ docker, fetchStatus: fakeFetch([200]) });
    expect(await runSmoke({ image: "img", pollMs: 1, arms: ["postgres"] }, d)).toBe(1);
    expect(errs.join("\n")).toMatch(/\[postgres\] 1 of \d+ probe\(s\) failed: pgvector/);
  });

  it("fails when /healthz is up but a storage probe fails (the #54 shape)", async () => {
    const { docker } = fakeDocker({ byArm: { sqlite: { exec: { lancedb: 1 } } } });
    const { deps: d, errs, out } = deps({ docker, fetchStatus: fakeFetch([200]) });
    expect(await runSmoke({ image: "img", pollMs: 1 }, d)).toBe(1);
    expect(out).toContain("OK: [sqlite] /healthz returned 200");
    expect(errs.join("\n")).toMatch(
      new RegExp(`\\[sqlite\\] 1 of ${probesFor("sqlite").length} probe\\(s\\) failed: lancedb`),
    );
    expect(errs.join("\n")).toContain("probe lancedb blew up");
    expect(errs.at(-1)).toBe("FAIL: img failed on: sqlite");
  });

  it("fails when docker run cannot start the container", async () => {
    const { docker, calls } = fakeDocker({ run: { status: 125, stderr: "no such image" } });
    const { deps: d, errs } = deps({ docker, fetchStatus: fakeFetch([200]) });
    expect(await runSmoke({ image: "img", pollMs: 1, arms: ["sqlite"] }, d)).toBe(1);
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

  it("never passes a generated secret on any docker command line (#51)", async () => {
    const { docker, calls, envs } = fakeDocker();
    const { deps: d } = deps({ docker, fetchStatus: fakeFetch([200]) });
    await runSmoke({ image: "img", pollMs: 1 }, d);
    for (const c of calls) expect(c.join(" ")).not.toContain("s3cr3t");
    // …and the values did reach docker, through its environment.
    expect(envs.filter((e) => e && Object.values(e).includes("s3cr3t")).length).toBeGreaterThan(0);
  });
});
