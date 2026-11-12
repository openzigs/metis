/**
 * #2335 — a refresh request starts the run off the caller's tick, or queues
 * the connector's one follow-up; the installed runner runs that follow-up once,
 * with the newest requested commit; the per-connector limit holds.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectorIngestLease } from "../../../src/lib/connectors/ingest-guard.js";

const h = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  runRepoConnectorRefresh: vi.fn(),
  runQueuedRepoConnectorSync: vi.fn(),
}));
vi.mock("../../../src/lib/logger.js", () => ({
  createChildLogger: () => ({ info: h.info, warn: h.warn, error: vi.fn(), debug: vi.fn() }),
}));
vi.mock("../../../src/lib/connectors/repo/repo-refresh.js", () => ({
  runRepoConnectorRefresh: h.runRepoConnectorRefresh,
}));
vi.mock("../../../src/lib/connectors/repo/repo-sync.js", () => ({
  runQueuedRepoConnectorSync: h.runQueuedRepoConnectorSync,
}));

import {
  __repoRefreshesInFlight,
  __repoRefreshRateLimitSize,
  __resetRepoRefreshRateLimit,
  __resetRepoRefreshShutdown,
  allowRepoRefreshRequest,
  stopRepoConnectorRefreshes,
  installRepoRefreshRerunRunner,
  requestRepoConnectorRefresh,
} from "../../../src/lib/connectors/repo/refresh-trigger.js";
import {
  acquireConnectorIngest,
  isConnectorIngestActive,
  setIngestRerunRunner,
} from "../../../src/lib/connectors/ingest-guard.js";

const SHA1 = "1".repeat(40);
const SHA2 = "2".repeat(40);
const SHA3 = "3".repeat(40);

/** Each refresh holds its lease until the test settles it, as a real run would. */
const pending: Array<{
  lease: ConnectorIngestLease;
  signal: AbortSignal;
  settle: (fail?: Error) => void;
}> = [];

/** Both runners behave alike here; which one ran is what the tests read. */
const heldRun = (_id: string, lease: ConnectorIngestLease, signal: AbortSignal) =>
  new Promise((resolve, reject) => {
    pending.push({
      lease,
      signal,
      settle: (fail?: Error) => {
        lease.release();
        if (fail) reject(fail);
        else resolve({ headSha: SHA3, filesChanged: 2 });
      },
    });
  });

beforeEach(() => {
  h.runRepoConnectorRefresh.mockImplementation(heldRun);
  h.runQueuedRepoConnectorSync.mockImplementation(heldRun);
  installRepoRefreshRerunRunner();
});

afterEach(() => {
  setIngestRerunRunner(null);
  for (const p of pending.splice(0)) if (p.lease.held) p.settle();
  h.runRepoConnectorRefresh.mockReset();
  h.runQueuedRepoConnectorSync.mockReset();
  __resetRepoRefreshShutdown();
  h.info.mockClear();
  h.warn.mockClear();
  __resetRepoRefreshRateLimit();
  delete process.env.REPO_REFRESH_REQUEST_LIMIT_MAX;
  delete process.env.REPO_REFRESH_REQUEST_LIMIT_WINDOW_MS;
});

describe("requestRepoConnectorRefresh (#2335)", () => {
  it("starts an idle connector's refresh in the background, holding its lease", async () => {
    const out = requestRepoConnectorRefresh("rc-idle", { trigger: "push", commitSha: SHA1 });
    expect(out).toEqual({ status: "started", trigger: "push", commitSha: SHA1 });
    expect(h.runRepoConnectorRefresh).toHaveBeenCalledTimes(1);
    expect(h.runRepoConnectorRefresh.mock.calls[0]![0]).toBe("rc-idle");
    expect(isConnectorIngestActive("rc-idle")).toBe(true);
    pending[0]!.settle();
    await vi.waitFor(() =>
      expect(h.info).toHaveBeenCalledWith(
        "connector.refresh.done",
        expect.objectContaining({
          connectorId: "rc-idle",
          requestedCommitSha: SHA1,
          headSha: SHA3,
        }),
      ),
    );
    expect(isConnectorIngestActive("rc-idle")).toBe(false);
  });

  it("queues while a run holds the connector, then runs one follow-up with the newest commit", async () => {
    const first = requestRepoConnectorRefresh("rc-busy", { trigger: "push", commitSha: SHA1 });
    expect(first.status).toBe("started");
    expect(requestRepoConnectorRefresh("rc-busy", { trigger: "push", commitSha: SHA2 })).toEqual({
      status: "queued",
      trigger: "push",
      commitSha: SHA2,
      requests: 1,
    });
    expect(requestRepoConnectorRefresh("rc-busy", { trigger: "push", commitSha: SHA3 })).toEqual({
      status: "queued",
      trigger: "push",
      commitSha: SHA3,
      requests: 2,
    });
    expect(h.runRepoConnectorRefresh).toHaveBeenCalledTimes(1);
    pending[0]!.settle();
    expect(h.runRepoConnectorRefresh).toHaveBeenCalledTimes(2);
    expect(pending[1]!.lease.holder).toBe("rerun:push");
    expect(h.info).toHaveBeenCalledWith(
      "connector.refresh.start",
      expect.objectContaining({ connectorId: "rc-busy", requestedCommitSha: SHA3, requests: 2 }),
    );
    pending[1]!.settle();
    await vi.waitFor(() => expect(isConnectorIngestActive("rc-busy")).toBe(false));
    expect(h.runRepoConnectorRefresh).toHaveBeenCalledTimes(2);
  });

  it("runs a queued manual Sync's follow-up as a Sync, not as the unattended refresh", () => {
    const sync = acquireConnectorIngest("rc-manual", "refresh-ingest");
    expect(requestRepoConnectorRefresh("rc-manual", { trigger: "manual" }).status).toBe("queued");
    sync.release();
    expect(h.runQueuedRepoConnectorSync).toHaveBeenCalledTimes(1);
    expect(h.runQueuedRepoConnectorSync.mock.calls[0]![0]).toBe("rc-manual");
    expect(h.runRepoConnectorRefresh).not.toHaveBeenCalled();
    expect(pending[0]!.lease.holder).toBe("rerun:manual");
  });

  it("keeps the follow-up a Sync when a push folds in after a manual Sync", () => {
    const sync = acquireConnectorIngest("rc-sticky", "refresh-ingest");
    requestRepoConnectorRefresh("rc-sticky", { trigger: "manual" });
    expect(
      requestRepoConnectorRefresh("rc-sticky", { trigger: "push", commitSha: SHA1 }),
    ).toMatchObject({ status: "queued", trigger: "manual", commitSha: SHA1, requests: 2 });
    sync.release();
    expect(h.runQueuedRepoConnectorSync).toHaveBeenCalledTimes(1);
    expect(h.runRepoConnectorRefresh).not.toHaveBeenCalled();
  });

  it("runs a queued push or scheduled follow-up as the unattended refresh", () => {
    for (const trigger of ["push", "scheduled"] as const) {
      const sync = acquireConnectorIngest(`rc-${trigger}`, "refresh-ingest");
      requestRepoConnectorRefresh(`rc-${trigger}`, { trigger });
      sync.release();
    }
    expect(h.runRepoConnectorRefresh).toHaveBeenCalledTimes(2);
    expect(h.runQueuedRepoConnectorSync).not.toHaveBeenCalled();
  });

  it("ties every background run to the shutdown signal, and waits for runs in flight", async () => {
    requestRepoConnectorRefresh("rc-stop", { trigger: "push" });
    expect(__repoRefreshesInFlight()).toBe(1);
    expect(pending[0]!.signal.aborted).toBe(false);
    const stopping = stopRepoConnectorRefreshes(5_000);
    expect(pending[0]!.signal.aborted).toBe(true);
    let stopped = false;
    void stopping.then(() => (stopped = true));
    await Promise.resolve();
    expect(stopped).toBe(false);
    pending[0]!.settle(new Error("aborted"));
    await stopping;
    expect(__repoRefreshesInFlight()).toBe(0);
  });

  it("stops waiting for a run that ignores shutdown after the timeout", async () => {
    requestRepoConnectorRefresh("rc-stuck", { trigger: "push" });
    const started = Date.now();
    await stopRepoConnectorRefreshes(20);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(__repoRefreshesInFlight()).toBe(1);
  });

  it("a failed follow-up is logged and not retried", async () => {
    requestRepoConnectorRefresh("rc-fail", { trigger: "push", commitSha: SHA1 });
    requestRepoConnectorRefresh("rc-fail", { trigger: "push", commitSha: SHA2 });
    pending[0]!.settle(new Error("first failed"));
    pending[1]!.settle(new Error("pull failed"));
    await vi.waitFor(() =>
      expect(h.warn).toHaveBeenCalledWith(
        "connector.refresh.failed",
        expect.objectContaining({ connectorId: "rc-fail", error: "pull failed" }),
      ),
    );
    expect(h.runRepoConnectorRefresh).toHaveBeenCalledTimes(2);
    expect(isConnectorIngestActive("rc-fail")).toBe(false);
  });
});

describe("allowRepoRefreshRequest (#2335)", () => {
  it("allows the configured number per window per connector, then refuses until the window ends", () => {
    process.env.REPO_REFRESH_REQUEST_LIMIT_MAX = "3";
    process.env.REPO_REFRESH_REQUEST_LIMIT_WINDOW_MS = "1000";
    const t0 = 1_000_000;
    expect([1, 2, 3, 4].map(() => allowRepoRefreshRequest("rl-a", t0))).toEqual([
      true,
      true,
      true,
      false,
    ]);
    // Another connector has its own budget.
    expect(allowRepoRefreshRequest("rl-b", t0)).toBe(true);
    expect(allowRepoRefreshRequest("rl-a", t0 + 999)).toBe(false);
    expect(allowRepoRefreshRequest("rl-a", t0 + 1000)).toBe(true);
  });

  it("defaults to 20 a minute and ignores a nonsense override", () => {
    process.env.REPO_REFRESH_REQUEST_LIMIT_MAX = "not-a-number";
    const t0 = 5_000_000;
    const allowed = Array.from({ length: 21 }, () => allowRepoRefreshRequest("rl-d", t0));
    expect(allowed.filter(Boolean)).toHaveLength(20);
    expect(allowRepoRefreshRequest("rl-d", t0 + 59_999)).toBe(false);
    expect(allowRepoRefreshRequest("rl-d", t0 + 60_000)).toBe(true);
  });

  it("sweeps expired windows so the map stays bounded", () => {
    process.env.REPO_REFRESH_REQUEST_LIMIT_MAX = "1";
    process.env.REPO_REFRESH_REQUEST_LIMIT_WINDOW_MS = "10";
    for (let i = 0; i < 1000; i += 1) allowRepoRefreshRequest(`sweep-${i}`, 0);
    expect(__repoRefreshRateLimitSize()).toBe(1000);
    // The 1001st connector triggers the sweep; the old windows have expired.
    expect(allowRepoRefreshRequest("sweep-new", 100)).toBe(true);
    expect(__repoRefreshRateLimitSize()).toBe(1);
    // A swept connector starts a fresh window.
    expect(allowRepoRefreshRequest("sweep-0", 100)).toBe(true);
    expect(allowRepoRefreshRequest("sweep-0", 100)).toBe(false);
    expect(__repoRefreshRateLimitSize()).toBe(2);
  });

  it("never holds more than 1000 windows: when all are live, the oldest goes", () => {
    process.env.REPO_REFRESH_REQUEST_LIMIT_MAX = "1";
    for (let i = 0; i < 1000; i += 1) allowRepoRefreshRequest(`live-${i}`, i);
    expect(allowRepoRefreshRequest("live-new", 1000)).toBe(true);
    expect(__repoRefreshRateLimitSize()).toBe(1000);
    // The oldest window was dropped; a still-live one keeps its count.
    expect(allowRepoRefreshRequest("live-0", 1001)).toBe(true);
    expect(allowRepoRefreshRequest("live-999", 1001)).toBe(false);
    expect(__repoRefreshRateLimitSize()).toBe(1000);
  });
});
