/**
 * `smoke:server-image` — start a built `metis-server` image and prove it serves
 * `/healthz` (#39).
 *
 * The `api` CI job used to build the image and weigh it, and nothing else: an image
 * that exited at import time (`ERR_MODULE_NOT_FOUND`) still went green, which is how
 * `main` shipped a `metis-server` that could not start. This gate runs the image the
 * way an operator would (`docker run`, the image's own CMD, `NODE_ENV=production`),
 * polls `/healthz` until it answers 200, and then loads — inside the running
 * container — the native and lazily-imported modules `/healthz` never touches
 * (LanceDB, the MySQL and Oracle drivers, the Oracle Instant Client in thick mode).
 * A module that only fails when a user first opens a connector is a dead feature in
 * a live image; the probes make that a red build instead.
 *
 * #45 — it runs the image TWICE, once per database the image must serve:
 *   - `sqlite`: no `DATABASE_URL` at all, so the server's own default is what boots.
 *   - `postgres`: a throwaway Postgres container on a private docker network, and
 *     `DATABASE_URL=postgresql://…` pointing at it — the documented production
 *     topology (docker-compose.prod.yml, the Helm prod values). Until #45 that
 *     arm exited at import: the image's only generated Prisma client was SQLite.
 * Each arm boots the image (whose migration guard applies the schema before it
 * listens), polls `/healthz`, then asks the image's own Prisma CLI whether every
 * migration is applied and reads a migrated table through the server's own client.
 *
 * #54 — storage probes write through the SERVER'S OWN code to the SERVER'S OWN
 * default paths (`getVectorStore()`, `resolveDocumentStorage()`, run in the
 * container's working directory with the container's environment). The first
 * LanceDB probe wrote to `/tmp`, and passed while the real default,
 * `<cwd>/data/lancedb`, was `Permission denied` for the runtime user.
 *
 * #60 — two more arms of the same shape:
 *   - the `postgres` arm runs production's shared backends
 *     ({@link POSTGRES_ARM_BACKENDS}: `VECTOR_STORE=pgvector` and the Postgres rate
 *     limit, SSO state and leader election), and a `pgvector` probe writes, searches and reads back a vector
 *     through the server's own `PgVectorStore` — raw SQL through the relocated
 *     Postgres Prisma client, which nothing else here exercised;
 *   - `helm-default` runs the image the way the Helm chart's DEFAULT values do:
 *     read-only root filesystem, uid 1001, every capability dropped, no
 *     `DATABASE_URL`, and writable only where the chart mounts a volume
 *     ({@link HELM_DEFAULT_WRITABLE_PATHS}). Under those values the SQLite default
 *     could not be created, so the server never started.
 *
 * Fails (exit 1) when a container exits, when `/healthz` does not answer 200 within
 * the deadline, or when any probe exits non-zero; the server's log is printed in
 * every failure case. Every container and network it creates is removed.
 *
 * `docker` is invoked with an ARGUMENT ARRAY via `spawnSync`, never a shell string, so
 * no input reaches a shell (OWASP A03). The secrets it passes are generated per run
 * and never printed, and never appear on docker's command line either (#51): the
 * argv names them (`--env JWT_SECRET`) and the VALUES travel in the docker CLI's own
 * environment, which docker copies into the container. A command line is readable
 * by every user on the runner through `ps`; a process's environment is not.
 *
 * Usage: node scripts/lib/smoke-server-image.mjs --image metis-server:ci-123
 *        [--arm all|sqlite|postgres|helm-default] [--postgres-image pgvector/pgvector:pg16]
 *        [--timeout 120] [--port 14000]
 *
 * Exit codes: 0 healthy; 1 the image failed the smoke; 2 invalid invocation / no docker.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const DEFAULT_TIMEOUT_S = 120;
export const DEFAULT_HOST_PORT = 14000;
/** The port the image listens on (`ENV PORT=4000` in Dockerfile.server). */
export const CONTAINER_PORT = 4000;
/**
 * The configurations the image must boot under, in the order they run: SQLite with
 * the image's own default, Postgres (+ pgvector) as production runs it, and the
 * Helm chart's default values (#60).
 */
export const ARMS = Object.freeze(["sqlite", "postgres", "helm-default"]);
/**
 * Where the Helm chart's default values let the server container write: every
 * `mountPath` the server Deployment mounts (deploy/helm/metis/templates/
 * _components.tpl, with the paths from values.yaml `persistence.*`). Everything else
 * is read-only (`readOnlyRootFilesystem: true`). `helm-template-wiring.test.mjs`
 * fails when the chart and this list disagree.
 */
export const HELM_DEFAULT_WRITABLE_PATHS = Object.freeze([
  "/tmp",
  "/home/metis",
  "/app/server/data",
  "/app/server/data/uploads",
  "/app/server/data/lancedb",
]);
/**
 * #60 — the shared, Postgres-backed backends production selects
 * (deploy/helm/metis/values-prod.yaml `scaling.*`), set on the Postgres arm so it
 * boots the image as production does. S3 uploads are not among them: they need a
 * bucket.
 */
export const POSTGRES_ARM_BACKENDS = Object.freeze({
  VECTOR_STORE: "pgvector",
  DISCUSSION_RATE_LIMIT_BACKEND: "postgres",
  SSO_STATE_BACKEND: "postgres",
  SCHEDULER_LEADER_ELECTION: "postgres",
});
/** The chart's `runAsUser`/`runAsGroup` (templates/_helpers.tpl). */
export const HELM_RUN_AS = "1001:1001";
/** Same image as the `postgres-adapter` and `postgres-migrate-deploy` CI jobs. */
export const DEFAULT_POSTGRES_IMAGE = "pgvector/pgvector:pg16";
/** Where the image keeps the compiled server (`Dockerfile.server`). */
const SERVER_DIST = "/app/server/dist";

/**
 * What `/healthz` does not exercise, each checked inside the running container.
 * Each `code` is an ES-module body run with `node --input-type=module -e` in the
 * container's own working directory (the image's `WORKDIR`, which is the server's
 * cwd) with the container's own environment, so it resolves packages and default
 * paths exactly as the server does. A probe passes by exiting 0. A probe with
 * `arms` runs only in those arms; one without runs in every arm.
 *
 * @type {ReadonlyArray<{ name: string, code: string, arms?: ReadonlyArray<string> }>}
 */
export const MODULE_PROBES = Object.freeze([
  {
    // #45 — the Prisma client the server itself uses (server/src/lib/prisma.ts),
    // reading a migrated table. On Postgres this is the client that used to refuse
    // `@prisma/adapter-pg` because it had been generated for SQLite.
    name: "database",
    code: [
      `const { prisma } = await import("${SERVER_DIST}/lib/prisma.js");`,
      "const n = await prisma.user.count();",
      "await prisma.$disconnect();",
      'if (!Number.isInteger(n)) throw new Error("user.count() returned " + n);',
    ].join(" "),
  },
  {
    // #45 — every migration in the history for THIS database is applied. The
    // image's own Prisma CLI, reading prisma.config.ts, which picks the SQLite or
    // Postgres history by DATABASE_URL scheme — the same CLI the boot-time
    // migration guard ran. `migrate status` exits non-zero on anything pending.
    name: "migrations",
    code: [
      'const { spawnSync } = await import("node:child_process");',
      'const { createRequire } = await import("node:module");',
      `const serverDir = "${SERVER_DIST}/..";`,
      // #51 — the CLI the package's `bin` names, as the migration guard resolves it.
      'const manifest = createRequire(serverDir + "/package.json").resolve("prisma/package.json");',
      'const { readFileSync } = await import("node:fs"); const { dirname, resolve } = await import("node:path");',
      'const bin = JSON.parse(readFileSync(manifest, "utf-8")).bin;',
      'const cli = resolve(dirname(manifest), typeof bin === "string" ? bin : bin.prisma);',
      'const r = spawnSync(process.execPath, [cli, "migrate", "status"], { cwd: serverDir, encoding: "utf-8" });',
      'if (r.status !== 0) { process.stderr.write((r.stdout ?? "") + (r.stderr ?? "")); process.exit(r.status ?? 1); }',
    ].join(" "),
  },
  {
    // #54 — the RAG vector store at the server's DEFAULT path, through the server's
    // own factory (rag/vector-store.ts: LANCEDB_PATH, else <cwd>/data/lancedb).
    // LanceDB's native binding ships for glibc only, so this also proves it loads.
    name: "lancedb",
    // Not on `postgres`: that arm selects pgvector, as production does.
    arms: ["sqlite", "helm-default"],
    code: [
      `const { getVectorStore } = await import("${SERVER_DIST}/lib/rag/vector-store.js");`,
      "const vs = getVectorStore();",
      'if (vs.constructor.name !== "LanceVectorStore") throw new Error("the default vector store is " + vs.constructor.name);',
      'const p = "metis-smoke-" + process.pid;',
      'await vs.upsert(p, [{ id: "a", vector: [0.1, 0.2], metadata: { documentId: "d", chunkId: "a", filename: "f", position: 0, text: "t", embeddingModel: "smoke" } }]);',
      "const n = await vs.count(p);",
      "await vs.dropTable(p);",
      'if (n !== 1) throw new Error("LanceDB count after one upsert was " + n);',
    ].join(" "),
  },
  {
    // #60 — the production vector store (VECTOR_STORE=pgvector, values-prod.yaml),
    // through the server's own factory and store: a write, a similarity search and a
    // count, all raw SQL through the relocated Postgres Prisma client. The store
    // sizes its column from the embedder, so the probe writes a vector of that width.
    name: "pgvector",
    arms: ["postgres"],
    code: [
      `const { registerPgVectorStore } = await import("${SERVER_DIST}/lib/rag/vector-store-pgvector.js");`,
      `const { getVectorStore } = await import("${SERVER_DIST}/lib/rag/vector-store.js");`,
      `const { prisma } = await import("${SERVER_DIST}/lib/prisma.js");`,
      "registerPgVectorStore();",
      "const vs = getVectorStore();",
      'if (vs.constructor.name !== "PgVectorStore") throw new Error("VECTOR_STORE=pgvector gave " + vs.constructor.name);',
      "const dim = vs.dimension;",
      "const v = Array.from({ length: dim }, (_, i) => (i + 1) / dim);",
      'const p = "metis-smoke-" + process.pid;',
      'await vs.upsert(p, [{ id: "a", vector: v, metadata: { documentId: "d", chunkId: "a", filename: "f", position: 0, text: "t", embeddingModel: "smoke" } }]);',
      "const hits = await vs.search(p, v, 1);",
      "const n = await vs.count(p);",
      "await vs.dropTable(p);",
      "await prisma.$disconnect();",
      'if (n !== 1) throw new Error("pgvector count after one upsert was " + n);',
      'if (hits[0]?.row.id !== "a") throw new Error("pgvector search did not return the row it stored: " + JSON.stringify(hits.map((h) => h.row.id)));',
    ].join(" "),
  },
  {
    // #54 — uploaded documents at the server's DEFAULT path, through the server's
    // own backend (documents/storage.ts: UPLOAD_DIR, else <cwd>/data/uploads),
    // read back through the same backend.
    name: "uploads",
    code: [
      `const { resolveDocumentStorage } = await import("${SERVER_DIST}/lib/documents/storage.js");`,
      "const s = resolveDocumentStorage();",
      'const b = await s.write({ projectId: "metis-smoke", buffer: Buffer.from("smoke") });',
      "const back = await s.read(b.storagePath);",
      'await s.removeProject("metis-smoke");',
      'if (back.toString() !== "smoke") throw new Error("upload read back " + JSON.stringify(back.toString()));',
    ].join(" "),
  },
  {
    // The MySQL connector (server/src/lib/connectors/db/drivers/mysql.ts).
    name: "mysql2",
    code: 'const m = await import("mysql2/promise"); if (typeof m.createPool !== "function" && typeof m.default?.createPool !== "function") throw new Error("mysql2/promise has no createPool");',
  },
  {
    // The SQLite adapter behind the Prisma client and the SQLite connector.
    name: "better-sqlite3",
    code: 'const { default: D } = await import("better-sqlite3"); const db = new D(":memory:"); const r = db.prepare("select 1 as x").get(); if (r.x !== 1) throw new Error("better-sqlite3 select returned " + JSON.stringify(r));',
  },
  {
    // The server writes under the process user's home (per-session AI homes in
    // `~/.metis-sessions`, `~/.metis/auth.json`). alpine's `adduser --system`
    // created one; Debian's `useradd --system` does not unless asked (#39).
    name: "home-writable",
    code: 'const os = await import("node:os"); const fs = await import("node:fs"); const path = await import("node:path"); const d = path.join(os.homedir(), ".metis-sessions", "smoke"); fs.mkdirSync(d, { recursive: true }); fs.rmSync(d, { recursive: true });',
  },
  {
    // The Oracle connector in thick mode (server/src/lib/connectors/db/drivers/oracle.ts),
    // which is what the Instant Client in the image exists for.
    name: "oracle-thick",
    code: 'const { default: o } = await import("oracledb"); o.initOracleClient({ libDir: process.env.ORACLE_CLIENT_DIR || "/opt/oracle/instantclient" }); if (o.thin !== false) throw new Error("oracledb did not enter thick mode");',
  },
]);

/**
 * Parse CLI flags. Unknown flags and missing values are invocation errors.
 *
 * @param {string[]} argv
 * @returns {{ image: string, timeoutS: number, port: number, arms: string[], postgresImage: string } | { error: string }}
 */
export function parseSmokeArgs(argv) {
  const out = {
    image: "",
    timeoutS: DEFAULT_TIMEOUT_S,
    port: DEFAULT_HOST_PORT,
    arms: [...ARMS],
    postgresImage: DEFAULT_POSTGRES_IMAGE,
  };
  const known = ["--image", "--timeout", "--port", "--arm", "--postgres-image"];
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!known.includes(flag)) return { error: `unknown argument: ${flag}` };
    if (value == null || value.startsWith("--")) return { error: `${flag} needs a value` };
    i += 1;
    if (flag === "--image") {
      out.image = value;
      continue;
    }
    if (flag === "--postgres-image") {
      out.postgresImage = value;
      continue;
    }
    if (flag === "--arm") {
      if (value === "all") out.arms = [...ARMS];
      else if (ARMS.includes(value)) out.arms = [value];
      else return { error: `--arm must be one of: all, ${ARMS.join(", ")}` };
      continue;
    }
    const n = Number(value);
    if (!Number.isInteger(n) || n <= 0) return { error: `${flag} must be a positive integer` };
    if (flag === "--timeout") out.timeoutS = n;
    else out.port = n;
  }
  if (!out.image) return { error: "--image is required" };
  return out;
}

/**
 * The `docker run` invocation: its argv, and the environment the docker CLI must be
 * given for it. The image's own CMD is used — the smoke must start the process an
 * operator starts, not a stand-in for it.
 *
 * Secret values are NEVER in `args` (#51). Each is named there as a bare
 * `--env NAME`, which docker resolves from its own environment, and the value is
 * returned in `env` for the caller to hand to the docker process.
 *
 * `databaseUrl` is omitted on the SQLite arms on purpose (#54): an explicit
 * `file:/tmp/...` URL is a scratch path that passes whether or not the image's own
 * default is writable. `helmDefault` (#60) applies the Helm chart's default
 * container constraints.
 *
 * @param {{ image: string, name: string, port: number, jwtSecret: string, vaultKey: string, embeddingsToken: string, network?: string, databaseUrl?: string, backends?: Readonly<Record<string, string>>, helmDefault?: boolean }} o
 * @returns {{ args: string[], env: Record<string, string> }}
 */
export function buildRunArgs({
  image,
  name,
  port,
  jwtSecret,
  vaultKey,
  embeddingsToken,
  network,
  databaseUrl,
  backends,
  helmDefault,
}) {
  /** @type {Record<string, string>} */
  const env = {
    // Real secrets, generated per run: production refuses the published dev JWT
    // key (#1057) and requires a vault key.
    JWT_SECRET: jwtSecret,
    VAULT_MASTER_KEY: vaultKey,
    // Required whenever EMBEDDINGS_MODE=sidecar (the image default): without it the
    // embeddings client throws while the routes are built and the process exits.
    EMBEDDINGS_TOKEN: embeddingsToken,
    // Carries the Postgres password.
    ...(databaseUrl ? { DATABASE_URL: databaseUrl } : {}),
  };
  const args = [
    "run",
    "--detach",
    "--name",
    name,
    ...(network ? ["--network", network] : []),
    ...(helmDefault
      ? [
          // deploy/helm/metis/templates/_helpers.tpl `metis.containerSecurityContext`.
          "--read-only",
          "--user",
          HELM_RUN_AS,
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges",
          // Each chart volume (an emptyDir or a PVC) is writable by the pod's user.
          ...HELM_DEFAULT_WRITABLE_PATHS.flatMap((p) => ["--tmpfs", `${p}:rw,exec,mode=1777`]),
        ]
      : []),
    "--publish",
    `127.0.0.1:${port}:${CONTAINER_PORT}`,
    ...Object.keys(env).flatMap((k) => ["--env", k]),
    ...Object.entries(backends ?? {}).flatMap(([k, v]) => ["--env", `${k}=${v}`]),
    // Production refuses the mock provider (#682). LDAP is the one real provider
    // that needs no reachable IdP to boot: it only connects on a login.
    "--env",
    "AUTH_MODE=ldap",
    "--env",
    "LDAP_URL=ldap://127.0.0.1:9",
    // No sidecars exist here. The embedder failing to warm is logged and the server
    // still starts (index.ts, #783); /readyz, not /healthz, reports it.
    "--env",
    "EMBEDDINGS_URL=http://127.0.0.1:9",
    "--env",
    "SQL_LINEAGE_MODE=in-process",
    image,
  ];
  return { args, env };
}

/**
 * @typedef {{ status: number | null, stdout: string, stderr: string }} DockerResult
 * @typedef {(args: string[], env?: Record<string, string>) => DockerResult} Docker
 * @typedef {{
 *   docker?: Docker,
 *   fetchStatus?: (url: string) => Promise<number | null>,
 *   sleep?: (ms: number) => Promise<void>,
 *   now?: () => number,
 *   log?: (msg: string) => void,
 *   err?: (msg: string) => void,
 *   secret?: (bytes: number, encoding: "hex" | "base64") => string,
 *   probes?: ReadonlyArray<{ name: string, code: string, arms?: ReadonlyArray<string> }>,
 * }} SmokeDeps
 */

/* c8 ignore start — real process/network adapters; tests inject all of these */
/** @type {Docker} */
function realDocker(args, env) {
  const r = spawnSync("docker", args, {
    encoding: "utf-8",
    maxBuffer: 16 * 1024 * 1024,
    // #51 — secret values reach docker here, never through its argv.
    env: env ? { ...process.env, ...env } : process.env,
  });
  if (r.error) return { status: null, stdout: "", stderr: r.error.message };
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** @param {string} url @returns {Promise<number | null>} */
async function realFetchStatus(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return res.status;
  } catch {
    return null;
  }
}
/* c8 ignore stop */

/**
 * Start a throwaway Postgres on a private network and wait until it accepts TCP
 * connections. `pg_isready -h 127.0.0.1` rather than the socket: the image's init
 * script runs a temporary socket-only server first and then restarts it.
 *
 * @param {{ docker: Docker, sleep: (ms: number) => Promise<void>, now: () => number, err: (m: string) => void }} io
 * @param {{ pgName: string, network: string, postgresImage: string, password: string, timeoutS: number, pollMs: number }} o
 * @returns {Promise<boolean>}
 */
async function startPostgres(io, o) {
  const { docker, sleep, now, err } = io;
  const net = docker(["network", "create", o.network]);
  if (net.status !== 0) {
    err(`FAIL: could not create docker network ${o.network}: ${net.stderr.trim()}`);
    return false;
  }
  const pg = docker(
    [
      "run",
      "--detach",
      "--name",
      o.pgName,
      "--network",
      o.network,
      "--env",
      "POSTGRES_USER=metis",
      // #51 — named here, valued in docker's environment.
      "--env",
      "POSTGRES_PASSWORD",
      "--env",
      "POSTGRES_DB=metis",
      o.postgresImage,
    ],
    { POSTGRES_PASSWORD: o.password },
  );
  if (pg.status !== 0) {
    err(`FAIL: could not start ${o.postgresImage}: ${pg.stderr.trim()}`);
    return false;
  }
  const deadline = now() + o.timeoutS * 1000;
  while (now() < deadline) {
    const ready = docker([
      "exec",
      o.pgName,
      "pg_isready",
      "-h",
      "127.0.0.1",
      "-U",
      "metis",
      "-d",
      "metis",
    ]);
    if (ready.status === 0) return true;
    await sleep(o.pollMs);
  }
  err(`FAIL: ${o.postgresImage} did not accept connections within ${o.timeoutS}s`);
  const l = docker(["logs", "--tail", "50", o.pgName]);
  err(`${l.stdout}${l.stderr}`.trimEnd());
  return false;
}

/**
 * Boot the image once, in one arm, and run every probe that applies to it.
 *
 * @param {{ docker: Docker, fetchStatus: (url: string) => Promise<number | null>, sleep: (ms: number) => Promise<void>, now: () => number, log: (m: string) => void, err: (m: string) => void, secret: (bytes: number, encoding: "hex" | "base64") => string, probes: ReadonlyArray<{ name: string, code: string, arms?: ReadonlyArray<string> }> }} io
 * @param {{ image: string, database: string, timeoutS: number, port: number, pollMs: number, postgresImage: string }} o
 * @returns {Promise<number>} exit code
 */
async function runArm(io, o) {
  const { docker, fetchStatus, sleep, now, log, err, secret, probes } = io;
  const stamp = `${process.pid}-${now()}`;
  const name = `metis-smoke-${o.database}-${stamp}`;
  const cleanup = /** @type {string[][]} */ ([["rm", "--force", name]]);
  let network;
  let databaseUrl;
  try {
    if (o.database === "postgres") {
      network = `metis-smoke-net-${stamp}`;
      const pgName = `metis-smoke-pg-${stamp}`;
      const password = secret(16, "hex");
      // Removed in reverse order of creation: containers before their network.
      cleanup.push(["rm", "--force", pgName], ["network", "rm", network]);
      log(`==> [postgres] Starting ${o.postgresImage} as ${pgName} on ${network}`);
      const up = await startPostgres(io, {
        pgName,
        network,
        postgresImage: o.postgresImage,
        password,
        timeoutS: o.timeoutS,
        pollMs: o.pollMs,
      });
      if (!up) return 1;
      databaseUrl = `postgresql://metis:${password}@${pgName}:5432/metis`;
    }

    const dumpLogs = () => {
      const l = docker(["logs", "--tail", "200", name]);
      err(`---- ${name} log (last 200 lines) ----`);
      err(`${l.stdout}${l.stderr}`.trimEnd());
      err("---- end of log ----");
    };

    log(
      `==> [${o.database}] Starting ${o.image} as ${name} (127.0.0.1:${o.port} -> ${CONTAINER_PORT})`,
    );
    const run = buildRunArgs({
      image: o.image,
      name,
      port: o.port,
      jwtSecret: secret(32, "hex"),
      vaultKey: secret(32, "base64"),
      embeddingsToken: secret(32, "hex"),
      network,
      databaseUrl,
      // #60 — Postgres runs production's shared backends, pgvector among them.
      backends: o.database === "postgres" ? POSTGRES_ARM_BACKENDS : undefined,
      helmDefault: o.database === "helm-default",
    });
    const started = docker(run.args, run.env);
    if (started.status !== 0) {
      err(`FAIL: [${o.database}] docker run did not start the container: ${started.stderr.trim()}`);
      return 1;
    }

    const url = `http://127.0.0.1:${o.port}/healthz`;
    const deadline = now() + o.timeoutS * 1000;
    let healthy = false;
    let lastStatus = /** @type {number | null} */ (null);
    while (now() < deadline) {
      const state = docker(["inspect", "--format", "{{.State.Running}} {{.State.ExitCode}}", name]);
      const [running, exitCode] = state.stdout.trim().split(" ");
      if (state.status !== 0 || running !== "true") {
        err(
          `FAIL: [${o.database}] ${o.image} exited before serving /healthz (exit code ${exitCode ?? "unknown"})`,
        );
        dumpLogs();
        return 1;
      }
      lastStatus = await fetchStatus(url);
      if (lastStatus === 200) {
        healthy = true;
        break;
      }
      await sleep(o.pollMs);
    }
    if (!healthy) {
      err(
        `FAIL: [${o.database}] /healthz did not return 200 within ${o.timeoutS}s (last status: ${lastStatus ?? "no response"})`,
      );
      dumpLogs();
      return 1;
    }
    log(`OK: [${o.database}] /healthz returned 200`);

    const failed = [];
    const armProbes = probes.filter((p) => !p.arms || p.arms.includes(o.database));
    for (const probe of armProbes) {
      // No `--workdir`: the probe runs in the image's WORKDIR, the server's cwd, so
      // every cwd-relative default resolves exactly as it does for the server.
      const r = docker(["exec", name, "node", "--input-type=module", "-e", probe.code]);
      if (r.status === 0) {
        log(`OK: [${o.database}] probe ${probe.name}`);
      } else {
        failed.push(probe.name);
        err(`FAIL: [${o.database}] probe ${probe.name} (exit ${r.status ?? "none"})`);
        err(`${r.stdout}${r.stderr}`.trimEnd());
      }
    }
    if (failed.length > 0) {
      err(
        `FAIL: [${o.database}] ${failed.length} of ${armProbes.length} probe(s) failed: ${failed.join(", ")}`,
      );
      dumpLogs();
      return 1;
    }
    log(
      `PASS: [${o.database}] ${o.image} starts, serves /healthz and passes ${armProbes.length} probe(s)`,
    );
    return 0;
  } finally {
    for (const args of cleanup) docker(args);
  }
}

/**
 * Run every requested arm; each runs even when an earlier one failed, so one CI run
 * reports all of them.
 *
 * @param {{ image: string, timeoutS?: number, port?: number, pollMs?: number, arms?: string[], postgresImage?: string }} opts
 * @param {SmokeDeps} [deps]
 * @returns {Promise<number>} exit code
 */
export async function runSmoke(opts, deps = {}) {
  /* c8 ignore start — default adapters; tests inject every one */
  const io = {
    docker: deps.docker ?? realDocker,
    fetchStatus: deps.fetchStatus ?? realFetchStatus,
    sleep: deps.sleep ?? ((/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms))),
    now: deps.now ?? (() => Date.now()),
    log: deps.log ?? ((/** @type {string} */ m) => console.log(m)),
    err: deps.err ?? ((/** @type {string} */ m) => console.error(m)),
    secret:
      deps.secret ??
      ((/** @type {number} */ bytes, /** @type {"hex" | "base64"} */ encoding) =>
        randomBytes(bytes).toString(encoding)),
    probes: deps.probes ?? MODULE_PROBES,
  };
  /* c8 ignore stop */

  const version = io.docker(["version", "--format", "{{.Server.Version}}"]);
  if (version.status !== 0) {
    io.err(`ERR: docker is not available: ${version.stderr.trim()}`);
    return 2;
  }

  const arms = opts.arms ?? [...ARMS];
  const failedArms = [];
  for (const database of arms) {
    const code = await runArm(io, {
      image: opts.image,
      database,
      timeoutS: opts.timeoutS ?? DEFAULT_TIMEOUT_S,
      port: opts.port ?? DEFAULT_HOST_PORT,
      pollMs: opts.pollMs ?? 1000,
      postgresImage: opts.postgresImage ?? DEFAULT_POSTGRES_IMAGE,
    });
    if (code !== 0) failedArms.push(database);
  }
  if (failedArms.length > 0) {
    io.err(`FAIL: ${opts.image} failed on: ${failedArms.join(", ")}`);
    return 1;
  }
  io.log(`PASS: ${opts.image} passes every arm: ${arms.join(", ")}`);
  return 0;
}

/* c8 ignore start — CLI entry; exercised by CI and by hand, logic lives above */
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const parsed = parseSmokeArgs(process.argv.slice(2));
  if ("error" in parsed) {
    console.error(`ERR: ${parsed.error}`);
    console.error(
      `usage: smoke-server-image.mjs --image <tag> [--arm all|${ARMS.join("|")}] [--postgres-image <tag>] [--timeout <s>] [--port <n>]`,
    );
    process.exit(2);
  }
  process.exit(await runSmoke(parsed));
}
/* c8 ignore stop */
