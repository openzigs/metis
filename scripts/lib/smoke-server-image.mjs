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
 * Fails (exit 1) when the container exits, when `/healthz` does not answer 200 within
 * the deadline, or when any probe exits non-zero; the container's log is printed in
 * every failure case. The container is always removed.
 *
 * `docker` is invoked with an ARGUMENT ARRAY via `spawnSync`, never a shell string, so
 * no input reaches a shell (OWASP A03). The secrets it passes are generated per run
 * and never printed.
 *
 * Usage: node scripts/lib/smoke-server-image.mjs --image metis-server:ci-123
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
 * Modules `/healthz` does not load, each checked inside the running container.
 * Each `code` is an ES-module body run with `node --input-type=module -e` from
 * `/app/server`, so it resolves packages exactly as `server/dist` does. A probe
 * passes by exiting 0.
 *
 * @type {ReadonlyArray<{ name: string, code: string }>}
 */
export const MODULE_PROBES = Object.freeze([
  {
    // The RAG vector store (server/src/lib/rag/vector-store.ts). Its native
    // binding ships for glibc only; a musl runtime fails here, not at /healthz.
    name: "lancedb",
    code: [
      'const lancedb = await import("vectordb");',
      'const db = await lancedb.connect("/tmp/metis-smoke-lance");',
      'const t = await db.createTable("smoke", [{ id: "a", vector: [0.1, 0.2] }]);',
      "const n = await t.countRows();",
      'if (n !== 1) throw new Error("lancedb countRows returned " + n);',
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
 * @returns {{ image: string, timeoutS: number, port: number } | { error: string }}
 */
export function parseSmokeArgs(argv) {
  /** @type {{ image: string, timeoutS: number, port: number }} */
  const out = { image: "", timeoutS: DEFAULT_TIMEOUT_S, port: DEFAULT_HOST_PORT };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag !== "--image" && flag !== "--timeout" && flag !== "--port") {
      return { error: `unknown argument: ${flag}` };
    }
    if (value == null || value.startsWith("--")) return { error: `${flag} needs a value` };
    i += 1;
    if (flag === "--image") {
      out.image = value;
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
 * The `docker run` argv. The image's own CMD is used — the smoke must start the
 * process an operator starts, not a stand-in for it.
 *
 * @param {{ image: string, name: string, port: number, jwtSecret: string, vaultKey: string, embeddingsToken: string }} o
 * @returns {string[]}
 */
export function buildRunArgs({ image, name, port, jwtSecret, vaultKey, embeddingsToken }) {
  return [
    "run",
    "--detach",
    "--name",
    name,
    "--publish",
    `127.0.0.1:${port}:${CONTAINER_PORT}`,
    // Real secrets, generated per run: production refuses the published dev JWT
    // key (#1057) and requires a vault key.
    "--env",
    `JWT_SECRET=${jwtSecret}`,
    "--env",
    `VAULT_MASTER_KEY=${vaultKey}`,
    // Production refuses the mock provider (#682). LDAP is the one real provider
    // that needs no reachable IdP to boot: it only connects on a login.
    "--env",
    "AUTH_MODE=ldap",
    "--env",
    "LDAP_URL=ldap://127.0.0.1:9",
    // SQLite in the container's own /tmp, so the smoke needs no database service.
    "--env",
    "DATABASE_URL=file:/tmp/metis-smoke.db",
    // No sidecars exist here. The embedder failing to warm is logged and the server
    // still starts (index.ts, #783); /readyz, not /healthz, reports it.
    "--env",
    "EMBEDDINGS_URL=http://127.0.0.1:9",
    // Required whenever EMBEDDINGS_MODE=sidecar (the image default): without it the
    // embeddings client throws while the routes are built and the process exits.
    "--env",
    `EMBEDDINGS_TOKEN=${embeddingsToken}`,
    "--env",
    "SQL_LINEAGE_MODE=in-process",
    image,
  ];
}

/**
 * @typedef {{ status: number | null, stdout: string, stderr: string }} DockerResult
 * @typedef {{
 *   docker?: (args: string[]) => DockerResult,
 *   fetchStatus?: (url: string) => Promise<number | null>,
 *   sleep?: (ms: number) => Promise<void>,
 *   now?: () => number,
 *   log?: (msg: string) => void,
 *   err?: (msg: string) => void,
 *   secret?: (bytes: number, encoding: "hex" | "base64") => string,
 *   probes?: ReadonlyArray<{ name: string, code: string }>,
 * }} SmokeDeps
 */

/* c8 ignore start — real process/network adapters; tests inject all of these */
/** @param {string[]} args @returns {DockerResult} */
function realDocker(args) {
  const r = spawnSync("docker", args, { encoding: "utf-8", maxBuffer: 16 * 1024 * 1024 });
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
 * Start the image, wait for `/healthz` = 200, run the module probes, clean up.
 *
 * @param {{ image: string, timeoutS?: number, port?: number, pollMs?: number }} opts
 * @param {SmokeDeps} [deps]
 * @returns {Promise<number>} exit code
 */
export async function runSmoke(opts, deps = {}) {
  /* c8 ignore start — default adapters; tests inject every one */
  const docker = deps.docker ?? realDocker;
  const fetchStatus = deps.fetchStatus ?? realFetchStatus;
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? ((m) => console.log(m));
  const err = deps.err ?? ((m) => console.error(m));
  const secret = deps.secret ?? ((bytes, encoding) => randomBytes(bytes).toString(encoding));
  /* c8 ignore stop */
  const probes = deps.probes ?? MODULE_PROBES;
  const timeoutS = opts.timeoutS ?? DEFAULT_TIMEOUT_S;
  const port = opts.port ?? DEFAULT_HOST_PORT;
  const pollMs = opts.pollMs ?? 1000;

  const version = docker(["version", "--format", "{{.Server.Version}}"]);
  if (version.status !== 0) {
    err(`ERR: docker is not available: ${version.stderr.trim()}`);
    return 2;
  }

  const name = `metis-smoke-${process.pid}-${now()}`;
  const dumpLogs = () => {
    const l = docker(["logs", "--tail", "200", name]);
    err(`---- ${name} log (last 200 lines) ----`);
    err(`${l.stdout}${l.stderr}`.trimEnd());
    err("---- end of log ----");
  };

  log(`==> Starting ${opts.image} as ${name} (127.0.0.1:${port} -> ${CONTAINER_PORT})`);
  const started = docker(
    buildRunArgs({
      image: opts.image,
      name,
      port,
      jwtSecret: secret(32, "hex"),
      vaultKey: secret(32, "base64"),
      embeddingsToken: secret(32, "hex"),
    }),
  );
  if (started.status !== 0) {
    err(`FAIL: docker run did not start the container: ${started.stderr.trim()}`);
    docker(["rm", "--force", name]);
    return 1;
  }

  try {
    const url = `http://127.0.0.1:${port}/healthz`;
    const deadline = now() + timeoutS * 1000;
    let healthy = false;
    let lastStatus = /** @type {number | null} */ (null);
    while (now() < deadline) {
      const state = docker(["inspect", "--format", "{{.State.Running}} {{.State.ExitCode}}", name]);
      const [running, exitCode] = state.stdout.trim().split(" ");
      if (state.status !== 0 || running !== "true") {
        err(
          `FAIL: ${opts.image} exited before serving /healthz (exit code ${exitCode ?? "unknown"})`,
        );
        dumpLogs();
        return 1;
      }
      lastStatus = await fetchStatus(url);
      if (lastStatus === 200) {
        healthy = true;
        break;
      }
      await sleep(pollMs);
    }
    if (!healthy) {
      err(
        `FAIL: /healthz did not return 200 within ${timeoutS}s (last status: ${lastStatus ?? "no response"})`,
      );
      dumpLogs();
      return 1;
    }
    log(`OK: /healthz returned 200`);

    const failed = [];
    for (const probe of probes) {
      const r = docker([
        "exec",
        "--workdir",
        "/app/server",
        name,
        "node",
        "--input-type=module",
        "-e",
        probe.code,
      ]);
      if (r.status === 0) {
        log(`OK: module probe ${probe.name}`);
      } else {
        failed.push(probe.name);
        err(`FAIL: module probe ${probe.name} (exit ${r.status ?? "none"})`);
        err(`${r.stdout}${r.stderr}`.trimEnd());
      }
    }
    if (failed.length > 0) {
      err(
        `FAIL: ${failed.length} of ${probes.length} module probe(s) failed: ${failed.join(", ")}`,
      );
      return 1;
    }
    log(`PASS: ${opts.image} starts, serves /healthz and loads ${probes.length} runtime module(s)`);
    return 0;
  } finally {
    docker(["rm", "--force", name]);
  }
}

/* c8 ignore start — CLI entry; exercised by CI and by hand, logic lives above */
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const parsed = parseSmokeArgs(process.argv.slice(2));
  if ("error" in parsed) {
    console.error(`ERR: ${parsed.error}`);
    console.error("usage: smoke-server-image.mjs --image <tag> [--timeout <s>] [--port <n>]");
    process.exit(2);
  }
  process.exit(await runSmoke(parsed));
}
/* c8 ignore stop */
