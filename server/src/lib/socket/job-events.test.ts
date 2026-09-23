/**
 * Unit tests for the unified job-lifecycle emitter (Epic #238 / #239).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { JobKind, JobLifecycleEvent } from "@metis/shared";
import type { MetisIOServer } from "./server.js";
import {
  createJobEventEmitter,
  genericFailureMessage,
  getLastJobLifecycle,
  JOB_KINDS,
  NOOP_JOB_EMITTER,
  jobEvents,
  _resetJobLifecycleMemory,
} from "./job-events.js";
import * as registry from "./registry.js";

/** The new long-running kinds added by Epic #406 (#419) on top of the original 3. */
const NEW_JOB_KINDS: readonly JobKind[] = [
  "scan",
  "pr-review",
  "import-sync",
  "embeddings-reindex",
  "spec-kit",
  "overview-regenerate",
];

/** Minimal fake of the chainable `io.to(room).emit(name, payload)` surface. */
function makeFakeIo() {
  const emit = vi.fn();
  const to = vi.fn(() => ({ emit }));
  const io = { to } as unknown as MetisIOServer;
  return { io, to, emit };
}

describe("createJobEventEmitter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-17T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("broadcasts a lifecycle event on both the job room and the project room", () => {
    const { io, to, emit } = makeFakeIo();
    const e = createJobEventEmitter(io);

    e.started("analysis", "job-1", "proj-1", "kickoff");

    expect(to).toHaveBeenCalledWith("job:job-1");
    expect(to).toHaveBeenCalledWith("project:proj-1");
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenCalledWith("job:lifecycle", {
      kind: "analysis",
      jobId: "job-1",
      projectId: "proj-1",
      status: "started",
      message: "kickoff",
      ts: Date.parse("2026-06-17T00:00:00Z"),
    });
  });

  it("omits the project room when projectId is null (cross-project jobs)", () => {
    const { io, to, emit } = makeFakeIo();
    const e = createJobEventEmitter(io);

    e.started("impact-analysis", "imp-1", null);

    expect(to).toHaveBeenCalledTimes(1);
    expect(to).toHaveBeenCalledWith("job:imp-1");
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("emits progress with the supplied percentage", () => {
    const { io, emit } = makeFakeIo();
    const e = createJobEventEmitter(io);

    e.progress("doc-generation", "doc-1", "proj-1", 42, "section 3");

    expect(emit).toHaveBeenCalledWith(
      "job:lifecycle",
      expect.objectContaining({ status: "progress", progress: 42, message: "section 3" }),
    );
  });

  it("emits completed with progress pinned to 100", () => {
    const { io, emit } = makeFakeIo();
    const e = createJobEventEmitter(io);

    e.completed("analysis", "job-1", "proj-1");

    expect(emit).toHaveBeenCalledWith(
      "job:lifecycle",
      expect.objectContaining({ status: "completed", progress: 100 }),
    );
  });

  it("emits failed with the error message", () => {
    const { io, emit } = makeFakeIo();
    const e = createJobEventEmitter(io);

    e.failed("doc-generation", "doc-1", "proj-1", "boom");

    expect(emit).toHaveBeenCalledWith(
      "job:lifecycle",
      expect.objectContaining({ status: "failed", error: "boom" }),
    );
  });

  it("emits a per-section doc-generation event with warning on both rooms", () => {
    const { io, to, emit } = makeFakeIo();
    const e = createJobEventEmitter(io);

    e.docSection({
      jobId: "doc-1",
      projectId: "proj-1",
      section: "Risks",
      status: "degraded",
      index: 2,
      total: 5,
      warning: { kind: "section-ungrounded", severity: "warning", message: "ungrounded" },
    });

    expect(to).toHaveBeenCalledWith("job:doc-1");
    expect(to).toHaveBeenCalledWith("project:proj-1");
    expect(emit).toHaveBeenCalledWith(
      "job:doc-section",
      expect.objectContaining({ section: "Risks", status: "degraded", index: 2, total: 5 }),
    );
  });

  it("is a no-op when io is null (no throw)", () => {
    const e = createJobEventEmitter(null);
    expect(() => e.started("analysis", "j", "p")).not.toThrow();
    expect(() =>
      e.docSection({ jobId: "j", projectId: "p", section: "s", status: "queued" }),
    ).not.toThrow();
  });

  it("swallows transport errors instead of throwing into the job path", () => {
    const emit = vi.fn(() => {
      throw new Error("transport down");
    });
    const io = { to: vi.fn(() => ({ emit })) } as unknown as MetisIOServer;
    const e = createJobEventEmitter(io);
    expect(() => e.completed("analysis", "j", "p")).not.toThrow();
  });

  it("NOOP_JOB_EMITTER never throws", () => {
    expect(() => NOOP_JOB_EMITTER.progress("analysis", "j", "p", 10)).not.toThrow();
  });

  it("emits a raw lifecycle event via the low-level lifecycle() method", () => {
    const { io, to, emit } = makeFakeIo();
    const e = createJobEventEmitter(io);
    e.lifecycle({
      kind: "doc-generation",
      jobId: "d1",
      projectId: "p1",
      status: "progress",
      progress: 7,
    });
    expect(to).toHaveBeenCalledWith("job:d1");
    expect(emit).toHaveBeenCalledWith(
      "job:lifecycle",
      expect.objectContaining({ status: "progress", progress: 7 }),
    );
  });

  // ---- Epic #406 (#419): new long-running kinds round-trip the same seam ----

  it.each(NEW_JOB_KINDS)(
    "round-trips a %s lifecycle event to both the job room and the project room",
    (kind) => {
      const { io, to, emit } = makeFakeIo();
      const e = createJobEventEmitter(io);

      e.started(kind, "job-x", "proj-x", "kickoff");

      expect(to).toHaveBeenCalledWith("job:job-x");
      expect(to).toHaveBeenCalledWith("project:proj-x");
      expect(emit).toHaveBeenCalledTimes(2);
      expect(emit).toHaveBeenCalledWith("job:lifecycle", {
        kind,
        jobId: "job-x",
        projectId: "proj-x",
        status: "started",
        message: "kickoff",
        ts: Date.parse("2026-06-17T00:00:00Z"),
      });
    },
  );

  it("emits a full started -> progress -> completed sequence for a new kind", () => {
    const { io, emit } = makeFakeIo();
    const e = createJobEventEmitter(io);

    e.started("scan", "scan-1", "proj-1", "queued");
    e.progress("scan", "scan-1", "proj-1", 55, "scanning files");
    e.completed("scan", "scan-1", "proj-1", "done");

    expect(emit).toHaveBeenCalledWith(
      "job:lifecycle",
      expect.objectContaining({ kind: "scan", status: "started" }),
    );
    expect(emit).toHaveBeenCalledWith(
      "job:lifecycle",
      expect.objectContaining({ kind: "scan", status: "progress", progress: 55 }),
    );
    expect(emit).toHaveBeenCalledWith(
      "job:lifecycle",
      expect.objectContaining({ kind: "scan", status: "completed", progress: 100 }),
    );
  });

  it("emits a started -> failed sequence for a new kind", () => {
    const { io, emit } = makeFakeIo();
    const e = createJobEventEmitter(io);

    e.started("embeddings-reindex", "idx-1", "proj-1");
    e.failed("embeddings-reindex", "idx-1", "proj-1", genericFailureMessage("embeddings-reindex"));

    expect(emit).toHaveBeenCalledWith(
      "job:lifecycle",
      expect.objectContaining({ kind: "embeddings-reindex", status: "started" }),
    );
    expect(emit).toHaveBeenCalledWith(
      "job:lifecycle",
      expect.objectContaining({
        kind: "embeddings-reindex",
        status: "failed",
        error: genericFailureMessage("embeddings-reindex"),
      }),
    );
  });
});

describe("jobEvents (registry-backed module singleton)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("resolves the live IO server from the registry on each call", () => {
    const { io, to } = makeFakeIo();
    vi.spyOn(registry, "getSocketServer").mockReturnValue(io);

    jobEvents.started("analysis", "job-9", "proj-9");

    expect(to).toHaveBeenCalledWith("job:job-9");
  });

  it("is a silent no-op when no IO server is registered", () => {
    vi.spyOn(registry, "getSocketServer").mockReturnValue(null);
    expect(() => jobEvents.completed("analysis", "j", "p")).not.toThrow();
    expect(() =>
      jobEvents.docSection({ jobId: "j", projectId: "p", section: "s", status: "done" }),
    ).not.toThrow();
  });

  it("routes every public method through the registry-resolved IO server", () => {
    const { io, to, emit } = makeFakeIo();
    vi.spyOn(registry, "getSocketServer").mockReturnValue(io);

    jobEvents.lifecycle({ kind: "analysis", jobId: "j", projectId: "p", status: "started" });
    jobEvents.progress("analysis", "j", "p", 50);
    jobEvents.failed("analysis", "j", "p", "err");
    jobEvents.docSection({ jobId: "j", projectId: "p", section: "Intro", status: "generating" });

    expect(to).toHaveBeenCalledWith("job:j");
    expect(emit).toHaveBeenCalledWith(
      "job:lifecycle",
      expect.objectContaining({ status: "started" }),
    );
    expect(emit).toHaveBeenCalledWith(
      "job:lifecycle",
      expect.objectContaining({ status: "progress", progress: 50 }),
    );
    expect(emit).toHaveBeenCalledWith(
      "job:lifecycle",
      expect.objectContaining({ status: "failed", error: "err" }),
    );
    expect(emit).toHaveBeenCalledWith(
      "job:doc-section",
      expect.objectContaining({ section: "Intro" }),
    );
  });
});

// ---- Issue #254: generic, user-safe failure messages -----------------------

describe("genericFailureMessage (#254)", () => {
  it("preserves the stable, user-safe strings for the original three kinds", () => {
    expect(genericFailureMessage("analysis")).toBe("Analysis failed");
    expect(genericFailureMessage("doc-generation")).toBe("Document generation failed");
    expect(genericFailureMessage("impact-analysis")).toBe("Impact analysis failed");
  });

  it("returns a non-empty, user-safe string for EVERY job kind (no raw-error leak)", () => {
    // Iterate the canonical kind list so a newly added kind without a message
    // fails here loudly (the #254 invariant is enforced for all kinds, not just 3).
    for (const kind of JOB_KINDS) {
      const message = genericFailureMessage(kind);
      expect(message).toBeTruthy();
      expect(message.length).toBeGreaterThan(0);
      // A user-safe message must not look like a raw stack/error string.
      expect(message).not.toMatch(/Error:|ECONNREFUSED|undefined|\[object/i);
    }
  });

  it("returns a user-safe failure string for each NEW kind", () => {
    expect(genericFailureMessage("scan")).toBe("The scan failed. Please try again.");
    expect(genericFailureMessage("pr-review")).toBe(
      "The pull request review failed. Please try again.",
    );
    expect(genericFailureMessage("import-sync")).toBe("The import sync failed. Please try again.");
    expect(genericFailureMessage("embeddings-reindex")).toBe(
      "The embeddings reindex failed. Please try again.",
    );
    expect(genericFailureMessage("spec-kit")).toBe(
      "The Spec Kit operation failed. Please try again.",
    );
    expect(genericFailureMessage("overview-regenerate")).toBe(
      "The overview regeneration failed. Please try again.",
    );
  });

  it("exposes JOB_KINDS containing the original 3 plus the 6 new kinds (9 total)", () => {
    expect(JOB_KINDS).toContain("analysis");
    expect(JOB_KINDS).toContain("doc-generation");
    expect(JOB_KINDS).toContain("impact-analysis");
    for (const kind of NEW_JOB_KINDS) {
      expect(JOB_KINDS).toContain(kind);
    }
    expect(new Set(JOB_KINDS).size).toBe(JOB_KINDS.length); // no duplicates
    expect(JOB_KINDS).toHaveLength(9);
  });

  it("emits only the generic message on a failed event — never the raw error", () => {
    const events: JobLifecycleEvent[] = [];
    const emit = vi.fn((_name: string, payload: JobLifecycleEvent) => events.push(payload));
    const io = { to: vi.fn(() => ({ emit })) } as unknown as MetisIOServer;
    const e = createJobEventEmitter(io);

    // The call sites resolve the message via genericFailureMessage before emit.
    const RAW =
      "ECONNREFUSED 10.0.3.14:5432 — prisma P2024 on table secret_tokens at /srv/db.ts:88";
    e.failed("impact-analysis", "job_1", null, genericFailureMessage("impact-analysis"));

    expect(events).toHaveLength(1);
    expect(events[0].error).toBe("Impact analysis failed");
    const serialized = JSON.stringify(events[0]);
    expect(serialized).not.toContain(RAW);
    expect(serialized).not.toContain("ECONNREFUSED");
    expect(serialized).not.toContain("secret_tokens");
  });
});

/**
 * A socket room only delivers what is emitted while the client is in it, and a
 * client cannot join `job:{id}` until the trigger endpoint has answered. A job
 * shorter than that round-trip therefore emitted its whole lifecycle into an
 * empty room, and the surface waited forever. The emitter remembers the last
 * transition so the socket server can replay it to a late subscriber.
 */
describe("last-event memory for late subscribers", () => {
  beforeEach(() => {
    _resetJobLifecycleMemory();
  });

  it("remembers the most recent transition per job", () => {
    const { io } = makeFakeIo();
    const emitter = createJobEventEmitter(io);
    emitter.started("embeddings-reindex", "job-1", "proj-1", "Reindexing embeddings");
    emitter.completed("embeddings-reindex", "job-1", "proj-1", "Reindexed 4 of 4 chunks.");

    const last = getLastJobLifecycle("job-1");
    expect(last?.status).toBe("completed");
    expect(last?.message).toBe("Reindexed 4 of 4 chunks.");
    expect(last?.progress).toBe(100);
  });

  it("keeps jobs apart and reports nothing for an unknown job", () => {
    const { io } = makeFakeIo();
    const emitter = createJobEventEmitter(io);
    emitter.started("scan", "job-a", null);
    emitter.failed("scan", "job-b", null, genericFailureMessage("scan"));

    expect(getLastJobLifecycle("job-a")?.status).toBe("started");
    expect(getLastJobLifecycle("job-b")?.status).toBe("failed");
    expect(getLastJobLifecycle("job-never-seen")).toBeUndefined();
  });

  it("remembers even when no IO server is wired (emit is a no-op)", () => {
    NOOP_JOB_EMITTER.completed("spec-kit", "job-offline", null, "done");
    expect(getLastJobLifecycle("job-offline")?.status).toBe("completed");
  });

  it("evicts the oldest jobs beyond the cap so memory stays bounded", () => {
    const { io } = makeFakeIo();
    const emitter = createJobEventEmitter(io);
    for (let i = 0; i < 520; i += 1) {
      emitter.started("scan", `bounded-${i}`, null);
    }
    expect(getLastJobLifecycle("bounded-0")).toBeUndefined();
    expect(getLastJobLifecycle("bounded-519")?.status).toBe("started");
  });
});
