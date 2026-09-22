/**
 * Issues #16 and #17 — measure a real code-graph ingest of a directory.
 *
 *   DATABASE_URL=file:/abs/scratch.db pnpm exec tsx scripts/bench-ingest.ts --root <dir>
 *
 * (Create the scratch database first: `DATABASE_URL=file:/abs/scratch.db pnpm exec
 * prisma migrate deploy`.)
 *
 * Reports two things the unit suite can only approximate:
 *
 *  1. Event-loop responsiveness (#16). While `ingestCodeGraph` runs, a WORKER
 *     thread probes an HTTP `/healthz` served by the main thread every 250 ms
 *     (10 s timeout), the way an external load balancer would, and a 20 ms
 *     interval on the main thread records every stall. With the SQLite adapter
 *     (`better-sqlite3`, synchronous) each Prisma call settles on the microtask
 *     queue, so a loop of awaited writes never lets the event loop turn.
 *  2. The overview's "Top Symbols by In-Degree" table (#17), exactly as the Code
 *     Overview renders it.
 *
 * Refuses anything but a `file:` DATABASE_URL, and refuses a database that
 * already holds any project: the dev database is a `file:` URL too, so the scheme
 * alone is no guard. It creates a throwaway user and project and deletes them in
 * a `finally`, so a failed ingest leaves nothing behind.
 */
/* eslint-disable no-console */
import http from "node:http";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { Worker } from "node:worker_threads";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, i)];
}

// Plain CommonJS, evaluated in a worker: its event loop is independent of the one
// under test, so it keeps probing — and timing — while the main loop is blocked.
// An in-process prober is starved along with everything else and reports nothing.
const PROBER_SOURCE = `
const http = require("node:http");
const { parentPort, workerData } = require("node:worker_threads");
const latencies = [];
let timeouts = 0;
let errors = 0;
let stop = false;
parentPort.on("message", () => { stop = true; });
const once = () => new Promise((resolve) => {
  const t0 = performance.now();
  const req = http.get(
    { host: "127.0.0.1", port: workerData.port, path: "/healthz", timeout: 10000, agent: false },
    (res) => {
      res.resume();
      res.on("end", () => { latencies.push(performance.now() - t0); resolve(); });
    },
  );
  req.on("timeout", () => { timeouts += 1; req.destroy(); resolve(); });
  req.on("error", () => { errors += 1; resolve(); });
});
(async () => {
  while (!stop) {
    await once();
    await new Promise((r) => setTimeout(r, 250));
  }
  parentPort.postMessage({ latencies, timeouts, errors });
})();
`;

async function main(): Promise<void> {
  const root = arg("root");
  const dbUrl = process.env.DATABASE_URL ?? "";
  if (!root) throw new Error("--root <dir> is required");
  if (!dbUrl.startsWith("file:")) {
    throw new Error("DATABASE_URL must be a scratch file: URL — refusing to touch a real database");
  }

  const { prisma } = await import("../src/lib/prisma.js");

  // A scratch database is empty; the live dev database is not.
  const existingProjects = await prisma.project.count();
  if (existingProjects > 0) {
    await prisma.$disconnect();
    throw new Error(
      `DATABASE_URL already holds ${existingProjects} project(s) — refusing: point it at an empty scratch database`,
    );
  }

  const tag = `bench-${Date.now()}`;
  const user = await prisma.user.create({
    data: { email: `${tag}@bench.invalid`, displayName: tag, username: tag },
  });
  const project = await prisma.project.create({
    data: { name: tag, slug: tag, createdById: user.id },
  });
  try {
    await run(project.id, user.id, root);
  } finally {
    await prisma.project.delete({ where: { id: project.id } });
    await prisma.user.delete({ where: { id: user.id } });
    await prisma.$disconnect();
  }
}

async function run(projectId: string, userId: string, root: string): Promise<void> {
  const { prisma } = await import("../src/lib/prisma.js");
  const { ingestCodeGraph } = await import("../src/lib/code-graph/ingest.js");
  const { generateOverview } = await import("../src/lib/code-graph/overview.js");

  const server = http.createServer((req, res) => {
    res.writeHead(req.url === "/healthz" ? 200 : 404).end("ok");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;

  const prober = new Worker(PROBER_SOURCE, { eval: true, workerData: { port } });
  const proberDone = new Promise<{ latencies: number[]; timeouts: number; errors: number }>((r) =>
    prober.once("message", r),
  );

  const t0 = performance.now();
  const lags: number[] = [];
  const stalls: Array<{ atS: number; ms: number }> = [];
  let last = performance.now();
  const recordGap = (now: number) => {
    const lag = Math.max(0, now - last - 20);
    lags.push(lag);
    if (lag > 200) stalls.push({ atS: Math.round((last - t0) / 1000), ms: Math.round(lag) });
    last = now;
  };
  const ticker = setInterval(() => recordGap(performance.now()), 20);

  // BENCH_SLOW_QUERIES=1 — log every Prisma call that holds the loop > 200 ms.
  const slow: Array<{ atS: number; ms: number; op: string }> = [];
  const opLog: Array<{ t: number; op: string }> = [];
  const client =
    process.env.BENCH_SLOW_QUERIES === "1"
      ? prisma.$extends({
          query: {
            $allModels: {
              async $allOperations({ model, operation, args, query }) {
                const q0 = performance.now();
                const out = await query(args);
                const ms = performance.now() - q0;
                opLog.push({ t: q0 - t0, op: `${model}.${operation}` });
                if (ms > 200) {
                  slow.push({
                    atS: Math.round((q0 - t0) / 1000),
                    ms: Math.round(ms),
                    op: `${model}.${operation}`,
                  });
                }
                return out;
              },
            },
          },
        })
      : prisma;

  const stats = await ingestCodeGraph(client as typeof prisma, {
    projectId,
    rootDir: path.resolve(root),
    incremental: false,
    triggeredByUserId: userId,
    sqlLineageOverride: false,
  });
  const wallMs = performance.now() - t0;
  // The gap still open when ingest resolves matters most: a loop blocked until
  // the very end never fires its late tick, so without this a fully-blocked run
  // would report "no stalls".
  recordGap(performance.now());
  clearInterval(ticker);
  prober.postMessage("stop");
  const probe = await proberDone;
  await prober.terminate();
  server.close();

  const overview = await generateOverview(prisma, projectId);
  const table = overview.markdown.split("\n").filter((l) => /^\| \d+ \|/.test(l));
  const resolvedCalls = await prisma.codeEdge.count({
    where: { projectId, kind: "calls", NOT: { toSymbolId: null } },
  });
  const totalCalls = await prisma.codeEdge.count({
    where: { projectId, kind: "calls" },
  });

  const lat = [...probe.latencies].sort((a, b) => a - b);
  const lag = [...lags].sort((a, b) => a - b);
  const report = {
    root: path.resolve(root),
    wallMs: Math.round(wallMs),
    filesParsed: stats.filesParsed,
    symbols: stats.symbolsUpserted,
    edges: stats.edgesUpserted,
    calls: { total: totalCalls, resolved: resolvedCalls },
    overview: {
      godNodes: overview.stats.godNodeCount,
      entryPoints: overview.stats.entryPointCount,
    },
    healthz: {
      probes: lat.length,
      timeouts: probe.timeouts,
      errors: probe.errors,
      p50: Math.round(pct(lat, 50)),
      p99: Math.round(pct(lat, 99)),
      max: Math.round(lat[lat.length - 1] ?? 0),
    },
    eventLoop: {
      ticks: lags.length,
      lagP99Ms: Math.round(pct(lag, 99)),
      lagMaxMs: Math.round(lag[lag.length - 1] ?? 0),
      stallsOver200ms: stalls.slice(0, 20),
    },
  };
  console.log(JSON.stringify(report, null, 2));
  if (slow.length) console.log("slow queries:", JSON.stringify(slow.slice(0, 40)));
  // BENCH_SLOW_QUERIES=1 — what ran inside each stall (op counts), to find loops
  // of individually-fast queries that never yield.
  for (const st of stalls) {
    const from = st.atS * 1000 - 1000;
    const to = from + st.ms + 2000;
    const counts: Record<string, number> = {};
    for (const o of opLog) if (o.t >= from && o.t <= to) counts[o.op] = (counts[o.op] ?? 0) + 1;
    if (Object.keys(counts).length)
      console.log("stall at %ss (%sms): %s", st.atS, st.ms, JSON.stringify(counts));
  }
  console.log("\nTop symbols by in-degree:");
  for (const l of table) console.log(l);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
