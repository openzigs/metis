/**
 * Issue #189 — measure `/healthz` latency from OUTSIDE the thread under test.
 *
 * A prober on the main thread is blocked by the same synchronous call it is trying
 * to detect: it simply fires its next probe after the block ends and reports a
 * fast answer. This one runs in its own worker_thread, so a request in flight while
 * the server's thread is blocked is timed for exactly as long as it waited.
 */
import { Worker } from "node:worker_threads";

const PROBER_SOURCE = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
let stop = false;
parentPort.on("message", () => { stop = true; });
(async () => {
  let worst = 0, probes = 0, failures = 0;
  parentPort.postMessage({ type: "started" });
  while (!stop) {
    const started = performance.now();
    try {
      const res = await fetch(workerData.url);
      await res.text();
      if (res.status !== 200) failures += 1;
    } catch {
      failures += 1;
    }
    worst = Math.max(worst, performance.now() - started);
    probes += 1;
    await new Promise((resolve) => setTimeout(resolve, workerData.intervalMs));
  }
  parentPort.postMessage({ type: "done", worst, probes, failures });
})();
`;

export interface HealthzProbeReport {
  /** Slowest single `/healthz` round-trip, in milliseconds. */
  worst: number;
  probes: number;
  failures: number;
}

/** Probe `url` every `intervalMs` from a worker thread while `work` runs. */
export async function probeHealthzDuring(
  url: string,
  work: () => Promise<unknown>,
  intervalMs = 20,
): Promise<HealthzProbeReport> {
  const prober = new Worker(PROBER_SOURCE, { eval: true, workerData: { url, intervalMs } });
  const messages = new Promise<HealthzProbeReport>((resolve, reject) => {
    prober.on("message", (message: { type: string } & HealthzProbeReport) => {
      if (message.type === "done") resolve(message);
    });
    prober.on("error", reject);
  });
  await new Promise<void>((resolve) =>
    prober.once("message", (message: { type: string }) => {
      if (message.type === "started") resolve();
    }),
  );
  // Let at least one probe complete before the work starts.
  await new Promise((resolve) => setTimeout(resolve, 3 * intervalMs));
  try {
    await work();
  } finally {
    prober.postMessage("stop");
  }
  const report = await messages;
  await prober.terminate();
  return report;
}
