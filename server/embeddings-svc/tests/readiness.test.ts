/**
 * Issue #786 — warm-at-boot readiness state machine.
 *
 * The invariant under test is the one that decides whether a bad deploy shows up
 * as a stalled rollout or as a CrashLoopBackOff: a model that fails to load must
 * leave the process ALIVE and NOT-READY, never reject out of `beginWarmup()`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { __resetReadinessForTests, beginWarmup, readinessSnapshot } from "../src/readiness.js";

const ENV_KEYS = ["EMBED_MODEL", "EMBED_DTYPE", "EMBED_POOLING", "EMBED_POOLING_MAP"] as const;

beforeEach(() => {
  __resetReadinessForTests();
  for (const key of ENV_KEYS) delete process.env[key];
});

describe("readiness snapshot", () => {
  it("reports `warming` before beginWarmup() is ever called", () => {
    // A process that never started warming has certainly not finished warming.
    const snap = readinessSnapshot();
    expect(snap.state).toBe("warming");
    expect(snap.model).toBe("Alibaba-NLP/gte-modernbert-base");
    expect(snap.dtype).toBe("q8");
    expect(snap.pooling).toBe("cls");
  });

  it("reports the configured model/dtype/pooling, not the compiled default", () => {
    process.env.EMBED_MODEL = "Xenova/bge-small-en-v1.5";
    process.env.EMBED_DTYPE = "fp32";
    const snap = readinessSnapshot();
    expect(snap.model).toBe("Xenova/bge-small-en-v1.5");
    expect(snap.dtype).toBe("fp32");
    expect(snap.pooling).toBe("mean");
  });
});

describe("beginWarmup", () => {
  it("stays `warming` while the pipeline is still loading", async () => {
    let release: (() => void) | undefined;
    const loader = vi.fn(
      () =>
        new Promise<unknown>((resolve) => {
          release = () => resolve({});
        }),
    );

    const done = beginWarmup(loader);
    expect(readinessSnapshot().state).toBe("warming");

    release?.();
    await done;
    expect(readinessSnapshot().state).toBe("ready");
  });

  it("transitions to `ready` and records how long the load took", async () => {
    const loader = vi.fn(async () => ({}));
    await beginWarmup(loader);

    const snap = readinessSnapshot();
    expect(snap.state).toBe("ready");
    expect(snap.error).toBeUndefined();
    expect(snap.durationMs).toBeTypeOf("number");
    expect(loader).toHaveBeenCalledWith("Alibaba-NLP/gte-modernbert-base", "q8");
  });

  it("passes the resolved dtype through to the loader", async () => {
    process.env.EMBED_DTYPE = "fp32";
    const loader = vi.fn(async () => ({}));
    await beginWarmup(loader);
    expect(loader).toHaveBeenCalledWith("Alibaba-NLP/gte-modernbert-base", "fp32");
  });

  it("records a load failure as `error` WITHOUT rejecting (no crash-loop)", async () => {
    const loader = vi.fn(async () => {
      throw new Error("Could not locate file: model_quantized.onnx");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    // The promise resolves — an unhandled rejection here would kill the process
    // at boot, which is exactly the CrashLoopBackOff this design rejects.
    await expect(beginWarmup(loader)).resolves.toMatchObject({ state: "error" });

    const snap = readinessSnapshot();
    expect(snap.state).toBe("error");
    expect(snap.error).toContain("model_quantized.onnx");
  });

  it("stays in `error` forever — a failed load is permanent, not retried into readiness", async () => {
    const loader = vi.fn(async () => {
      throw new Error("boom");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    await beginWarmup(loader);

    // A second caller must not silently re-trigger a load and flip us to ready.
    const okLoader = vi.fn(async () => ({}));
    await beginWarmup(okLoader);
    expect(okLoader).not.toHaveBeenCalled();
    expect(readinessSnapshot().state).toBe("error");
  });

  it("is idempotent — repeated calls never build a second ONNX session", async () => {
    const loader = vi.fn(async () => ({}));
    const a = beginWarmup(loader);
    const b = beginWarmup(loader);
    expect(a).toBe(b);
    await Promise.all([a, b]);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("normalizes a non-Error throw into a readable message", async () => {
    const loader = vi.fn(async () => {
      throw "weights missing";
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    await beginWarmup(loader);
    expect(readinessSnapshot().error).toBe("weights missing");
  });
});
