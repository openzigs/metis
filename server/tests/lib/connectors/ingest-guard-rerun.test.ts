/**
 * #2335 — a sync requested while one runs sets ONE "re-run when done" marker
 * per connector; N requests during one run give exactly one follow-up, with
 * the newest requested commit, and a failed follow-up does not loop.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const warn = vi.hoisted(() => vi.fn());
vi.mock("../../../src/lib/logger.js", () => ({
  createChildLogger: () => ({ info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() }),
}));

import {
  acquireOrQueueConnectorIngest,
  isConnectorIngestActive,
  connectorIngestHolder,
  queuedConnectorIngest,
  setIngestRerunRunner,
  tryAcquireConnectorIngest,
  type ConnectorIngestLease,
  type QueuedIngestRerun,
} from "../../../src/lib/connectors/ingest-guard.js";

const sha = (n: number) => n.toString(16).padStart(40, "0").replace(/^0/, "a");

/** A runner that records each follow-up and holds its lease until told. */
function recordingRunner() {
  const runs: Array<{ lease: ConnectorIngestLease; rerun: QueuedIngestRerun }> = [];
  setIngestRerunRunner((lease, rerun) => {
    runs.push({ lease, rerun });
  });
  return runs;
}

afterEach(() => {
  setIngestRerunRunner(null);
  warn.mockClear();
});

describe("acquireOrQueueConnectorIngest (#2335)", () => {
  it("claims an idle connector and queues nothing", () => {
    const claim = acquireOrQueueConnectorIngest("c-idle", "push", { trigger: "push" });
    expect("lease" in claim).toBe(true);
    expect(queuedConnectorIngest("c-idle")).toBeNull();
    if ("lease" in claim) claim.lease.release();
    expect(isConnectorIngestActive("c-idle")).toBe(false);
  });

  it.each([1, 2, 25])(
    "%i request(s) during one run produce exactly one follow-up, with the newest commit",
    (n) => {
      const runs = recordingRunner();
      const running = tryAcquireConnectorIngest("c-many", "deep-ingest")!;
      for (let i = 1; i <= n; i += 1) {
        const out = acquireOrQueueConnectorIngest("c-many", "push", {
          trigger: "push",
          commitSha: sha(i),
        });
        expect(out).toEqual({
          queued: expect.objectContaining({ requests: i, commitSha: sha(i), trigger: "push" }),
        });
      }
      // Nothing runs while the holder still holds the connector.
      expect(runs).toHaveLength(0);
      running.release();
      expect(runs).toHaveLength(1);
      expect(runs[0]!.rerun).toMatchObject({ trigger: "push", commitSha: sha(n), requests: n });
      // The follow-up holds the lease from the same tick: no parallel run can start.
      expect(runs[0]!.lease.held).toBe(true);
      expect(connectorIngestHolder("c-many")).toBe("rerun:push");
      expect(queuedConnectorIngest("c-many")).toBeNull();
      runs[0]!.lease.release();
      expect(runs).toHaveLength(1);
      expect(isConnectorIngestActive("c-many")).toBe(false);
    },
  );

  it("a request naming no commit keeps the newest one named, and takes the latest trigger", () => {
    const runs = recordingRunner();
    const running = tryAcquireConnectorIngest("c-mixed", "scheduled-refresh")!;
    acquireOrQueueConnectorIngest("c-mixed", "push", { trigger: "push", commitSha: sha(7) });
    acquireOrQueueConnectorIngest("c-mixed", "refresh-ingest", { trigger: "manual" });
    running.release();
    expect(runs[0]!.rerun).toMatchObject({ trigger: "manual", commitSha: sha(7), requests: 2 });
    runs[0]!.lease.release();
  });

  it("a failed follow-up does not loop: its release fires nothing more", () => {
    let calls = 0;
    setIngestRerunRunner((lease) => {
      calls += 1;
      // The run fails; its `finally` releases the lease, as every runner does.
      lease.release();
    });
    const running = tryAcquireConnectorIngest("c-fail", "refresh-ingest")!;
    acquireOrQueueConnectorIngest("c-fail", "push", { trigger: "push", commitSha: sha(1) });
    running.release();
    expect(calls).toBe(1);
    expect(isConnectorIngestActive("c-fail")).toBe(false);
    expect(queuedConnectorIngest("c-fail")).toBeNull();
  });

  it("a request made while the follow-up runs queues exactly one more", () => {
    const runs = recordingRunner();
    const running = tryAcquireConnectorIngest("c-chain", "refresh-ingest")!;
    acquireOrQueueConnectorIngest("c-chain", "push", { trigger: "push", commitSha: sha(1) });
    running.release();
    acquireOrQueueConnectorIngest("c-chain", "push", { trigger: "push", commitSha: sha(2) });
    runs[0]!.lease.release();
    expect(runs.map((r) => r.rerun.commitSha)).toEqual([sha(1), sha(2)]);
    runs[1]!.lease.release();
    expect(runs).toHaveLength(2);
  });

  it("follows the lease's recovery rule: a second release of an old lease fires no second follow-up", () => {
    const runs = recordingRunner();
    const running = tryAcquireConnectorIngest("c-twice", "refresh-ingest")!;
    acquireOrQueueConnectorIngest("c-twice", "push", { trigger: "push" });
    running.release();
    running.release();
    expect(runs).toHaveLength(1);
    // And the follow-up's claim survived the stale release.
    expect(isConnectorIngestActive("c-twice")).toBe(true);
    runs[0]!.lease.release();
  });

  it("drops the marker, logged, when no runner is installed, and the connector is free again", () => {
    const running = tryAcquireConnectorIngest("c-norunner", "refresh-ingest")!;
    acquireOrQueueConnectorIngest("c-norunner", "push", { trigger: "push" });
    running.release();
    expect(isConnectorIngestActive("c-norunner")).toBe(false);
    expect(queuedConnectorIngest("c-norunner")).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      "connector.ingest.rerun_dropped",
      expect.objectContaining({ connectorId: "c-norunner" }),
    );
  });

  it("releases the follow-up's lease when the runner throws before it starts", () => {
    setIngestRerunRunner(() => {
      throw new Error("boom");
    });
    const running = tryAcquireConnectorIngest("c-throw", "refresh-ingest")!;
    acquireOrQueueConnectorIngest("c-throw", "push", { trigger: "push" });
    running.release();
    expect(isConnectorIngestActive("c-throw")).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      "connector.ingest.rerun_failed_to_start",
      expect.objectContaining({ connectorId: "c-throw", error: "boom" }),
    );
  });

  it("keeps one marker per connector", () => {
    const runs = recordingRunner();
    const a = tryAcquireConnectorIngest("c-a", "refresh-ingest")!;
    const b = tryAcquireConnectorIngest("c-b", "refresh-ingest")!;
    acquireOrQueueConnectorIngest("c-a", "push", { trigger: "push", commitSha: sha(1) });
    acquireOrQueueConnectorIngest("c-b", "push", { trigger: "push", commitSha: sha(2) });
    a.release();
    expect(runs.map((r) => [r.lease.connectorId, r.rerun.commitSha])).toEqual([["c-a", sha(1)]]);
    expect(queuedConnectorIngest("c-b")).toMatchObject({ commitSha: sha(2) });
    b.release();
    for (const r of runs) r.lease.release();
  });
});
