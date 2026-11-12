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
}));
vi.mock("../../../src/lib/logger.js", () => ({
  createChildLogger: () => ({ info: h.info, warn: h.warn, error: vi.fn(), debug: vi.fn() }),
}));
vi.mock("../../../src/lib/connectors/repo/repo-refresh.js", () => ({
  runRepoConnectorRefresh: h.runRepoConnectorRefresh,
}));

import {
  __resetRepoRefreshRateLimit,
  allowRepoRefreshRequest,
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
const pending: Array<{ lease: ConnectorIngestLease; settle: (fail?: Error) => void }> = [];

beforeEach(() => {
  h.runRepoConnectorRefresh.mockImplementation(
    (_id: string, lease: ConnectorIngestLease) =>
      new Promise((resolve, reject) => {
        pending.push({
          lease,
          settle: (fail?: Error) => {
            lease.release();
            if (fail) reject(fail);
            else resolve({ headSha: SHA3, filesChanged: 2 });
          },
        });
      }),
  );
  installRepoRefreshRerunRunner();
});

afterEach(() => {
  for (const p of pending.splice(0)) if (p.lease.held) p.lease.release();
  setIngestRerunRunner(null);
  h.runRepoConnectorRefresh.mockReset();
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

  it("runs the follow-up a manual Sync queued behind another entry point", () => {
    const sync = acquireConnectorIngest("rc-manual", "refresh-ingest");
    expect(requestRepoConnectorRefresh("rc-manual", { trigger: "manual" }).status).toBe("queued");
    sync.release();
    expect(h.runRepoConnectorRefresh).toHaveBeenCalledTimes(1);
    expect(pending[0]!.lease.holder).toBe("rerun:manual");
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
    // The 1001st connector triggers the sweep; the old windows have expired.
    expect(allowRepoRefreshRequest("sweep-new", 100)).toBe(true);
    // A swept connector starts a fresh window.
    expect(allowRepoRefreshRequest("sweep-0", 100)).toBe(true);
    expect(allowRepoRefreshRequest("sweep-0", 100)).toBe(false);
  });
});
