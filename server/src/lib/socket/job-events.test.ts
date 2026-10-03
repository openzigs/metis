/**
 * Unit tests for the unified job-lifecycle emitter (Epic #238 / #239).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { JobKind, JobLifecycleEvent } from "@metis/shared";
import type { MetisIOServer } from "./server.js";
import {
  createJobEventEmitter,
  genericFailureMessage,
  getJobScope,
  getLastDocSections,
  getLastJobLifecycle,
  JOB_KINDS,
  NOOP_JOB_EMITTER,
  jobEvents,
  _resetJobLifecycleMemory,
  rememberJobScope,
} from "./job-events.js";
import * as registry from "./registry.js";

/** The new long-running kinds added by Epic #406 (#419) on top of the original 3. */
const NEW_JOB_KINDS: readonly JobKind[] = [
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

    e.started("pr-review", "review-1", "proj-1", "queued");
    e.progress("pr-review", "review-1", "proj-1", 55, "reviewing files");
    e.completed("pr-review", "review-1", "proj-1", "done");

    expect(emit).toHaveBeenCalledWith(
      "job:lifecycle",
      expect.objectContaining({ kind: "pr-review", status: "started" }),
    );
    expect(emit).toHaveBeenCalledWith(
      "job:lifecycle",
      expect.objectContaining({ kind: "pr-review", status: "progress", progress: 55 }),
    );
    expect(emit).toHaveBeenCalledWith(
      "job:lifecycle",
      expect.objectContaining({ kind: "pr-review", status: "completed", progress: 100 }),
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

  it("exposes JOB_KINDS: the original 3, the 5 left from #419 and `repo-ingest` (#373) — 9 total", () => {
    expect(JOB_KINDS).toContain("analysis");
    expect(JOB_KINDS).toContain("doc-generation");
    expect(JOB_KINDS).toContain("impact-analysis");
    for (const kind of NEW_JOB_KINDS) {
      expect(JOB_KINDS).toContain(kind);
    }
    expect(JOB_KINDS).toContain("repo-ingest");
    expect(new Set(JOB_KINDS).size).toBe(JOB_KINDS.length); // no duplicates
    // #804 — `scan` went with the bug scanner.
    expect(JOB_KINDS).not.toContain("scan");
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
    emitter.started("pr-review", "job-a", null);
    emitter.failed("pr-review", "job-b", null, genericFailureMessage("pr-review"));

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
      emitter.started("pr-review", `bounded-${i}`, null);
    }
    expect(getLastJobLifecycle("bounded-0")).toBeUndefined();
    expect(getLastJobLifecycle("bounded-519")?.status).toBe("started");
  });
});

/**
 * #510 — a section that moves while the subscriber's socket is down is pushed
 * into a room it is no longer in. The emitter remembers each section's latest
 * state so `subscribe:job` can replay it, as it already does the lifecycle.
 */
describe("last doc-section memory for re-subscribers (#510)", () => {
  beforeEach(() => {
    _resetJobLifecycleMemory();
  });

  const section = (jobId: string, name: string, status: "generating" | "done" | "failed") => ({
    jobId,
    projectId: "proj-1",
    section: name,
    status,
  });

  it("keeps the latest state of each section, in first-reported order", () => {
    const { io } = makeFakeIo();
    const emitter = createJobEventEmitter(io);
    emitter.docSection(section("doc-1", "Overview", "generating"));
    emitter.docSection(section("doc-1", "Risks", "generating"));
    emitter.docSection(section("doc-1", "Overview", "done"));

    const sections = getLastDocSections("doc-1");
    expect(sections.map((s) => [s.section, s.status])).toEqual([
      ["Overview", "done"],
      ["Risks", "generating"],
    ]);
    expect(typeof sections[0].ts).toBe("number");
  });

  it("keeps jobs apart and reports nothing for an unknown job", () => {
    const { io } = makeFakeIo();
    const emitter = createJobEventEmitter(io);
    emitter.docSection(section("doc-a", "Overview", "done"));
    emitter.docSection(section("doc-b", "Risks", "generating"));

    expect(getLastDocSections("doc-a").map((s) => s.section)).toEqual(["Overview"]);
    expect(getLastDocSections("doc-b").map((s) => s.section)).toEqual(["Risks"]);
    expect(getLastDocSections("doc-never-seen")).toEqual([]);
  });

  it("remembers even when no IO server is wired (emit is a no-op)", () => {
    NOOP_JOB_EMITTER.docSection(section("doc-offline", "Overview", "done"));
    expect(getLastDocSections("doc-offline")[0]?.status).toBe("done");
  });

  it("evicts the oldest jobs beyond the cap, and a touched job counts as newest", () => {
    const { io } = makeFakeIo();
    const emitter = createJobEventEmitter(io);
    for (let i = 0; i < 510; i += 1) {
      emitter.docSection(section(`bounded-${i}`, "Overview", "generating"));
    }
    // Touch the oldest survivor so it moves to the back of the eviction order.
    emitter.docSection(section("bounded-10", "Risks", "done"));
    for (let i = 510; i < 520; i += 1) {
      emitter.docSection(section(`bounded-${i}`, "Overview", "generating"));
    }
    expect(getLastDocSections("bounded-0")).toEqual([]);
    expect(getLastDocSections("bounded-11")).toEqual([]);
    expect(getLastDocSections("bounded-10").map((s) => s.section)).toEqual(["Overview", "Risks"]);
    expect(getLastDocSections("bounded-519")).toHaveLength(1);
  });

  /**
   * Regenerating a document reuses its id as the job id, so a new run must not
   * inherit the previous run's section states: the UI counts `done`/`failed`
   * as terminal and would start the new run's counter part-way through.
   */
  it("forgets a job's sections when a new run of the same job id starts", () => {
    const { io } = makeFakeIo();
    const emitter = createJobEventEmitter(io);
    emitter.started("doc-generation", "doc-rerun", "proj-1");
    emitter.docSection(section("doc-rerun", "Overview", "done"));
    emitter.docSection(section("doc-rerun", "Risks", "failed"));
    emitter.failed("doc-generation", "doc-rerun", "proj-1", "boom");
    // Terminal transitions keep the sections: a late subscriber to the ended
    // run still learns how each section finished.
    expect(getLastDocSections("doc-rerun")).toHaveLength(2);

    emitter.started("doc-generation", "doc-rerun", "proj-1");
    expect(getLastDocSections("doc-rerun")).toEqual([]);

    emitter.docSection(section("doc-rerun", "Risks", "generating"));
    expect(getLastDocSections("doc-rerun").map((s) => [s.section, s.status])).toEqual([
      ["Risks", "generating"],
    ]);
  });

  it("keeps sections across progress events within one run", () => {
    const { io } = makeFakeIo();
    const emitter = createJobEventEmitter(io);
    emitter.started("doc-generation", "doc-progress", "proj-1");
    emitter.docSection(section("doc-progress", "Overview", "done"));
    emitter.progress("doc-generation", "doc-progress", "proj-1", 50);
    expect(getLastDocSections("doc-progress").map((s) => s.section)).toEqual(["Overview"]);
  });

  it("clears with the lifecycle memory", () => {
    NOOP_JOB_EMITTER.docSection(section("doc-reset", "Overview", "done"));
    _resetJobLifecycleMemory();
    expect(getLastDocSections("doc-reset")).toEqual([]);
  });
});

/** #655 — the scope a `job:{id}` room join is authorized against. */
describe("job scope memory (#655)", () => {
  beforeEach(() => {
    _resetJobLifecycleMemory();
  });

  it("takes a job's kind and project from its lifecycle events", () => {
    NOOP_JOB_EMITTER.started("spec-kit", "job-1", "proj-1");
    expect(getJobScope("job-1")).toEqual({ kind: "spec-kit", projectId: "proj-1" });
    NOOP_JOB_EMITTER.started("impact-analysis", "job-2", null);
    expect(getJobScope("job-2")).toEqual({ kind: "impact-analysis", projectId: null });
    expect(getJobScope("job-never-seen")).toBeUndefined();
  });

  it("scopes a job named only by doc-section events as a doc generation", () => {
    NOOP_JOB_EMITTER.docSection({
      jobId: "doc-1",
      projectId: "proj-1",
      section: "A",
      status: "done",
    });
    expect(getJobScope("doc-1")).toEqual({ kind: "doc-generation", projectId: "proj-1" });
  });

  it("keeps a lifecycle-derived scope when a doc-section names another project", () => {
    NOOP_JOB_EMITTER.started("doc-generation", "doc-2", "proj-1");
    NOOP_JOB_EMITTER.docSection({
      jobId: "doc-2",
      projectId: "proj-x",
      section: "A",
      status: "done",
    });
    expect(getJobScope("doc-2")).toEqual({ kind: "doc-generation", projectId: "proj-1" });
  });

  it("records a scope handed out before the job's first event, and the event refreshes it", () => {
    rememberJobScope("prr-1", "pr-review", "proj-1");
    expect(getJobScope("prr-1")).toEqual({ kind: "pr-review", projectId: "proj-1" });
    expect(getLastJobLifecycle("prr-1")).toBeUndefined();
    NOOP_JOB_EMITTER.started("pr-review", "prr-1", "proj-1");
    expect(getJobScope("prr-1")).toEqual({ kind: "pr-review", projectId: "proj-1" });
  });

  it("evicts the least recently touched event-derived scopes beyond the cap", () => {
    NOOP_JOB_EMITTER.started("pr-review", "kept", "proj-1");
    for (let i = 0; i < 499; i += 1) NOOP_JOB_EMITTER.started("pr-review", `filler-${i}`, "proj-1");
    // Touching `kept` makes `filler-0` the oldest.
    NOOP_JOB_EMITTER.progress("pr-review", "kept", "proj-1", 50);
    NOOP_JOB_EMITTER.started("pr-review", "one-more", "proj-1");
    expect(getJobScope("filler-0")).toBeUndefined();
    expect(getJobScope("kept")).toBeDefined();
    expect(getJobScope("one-more")).toBeDefined();
  });

  it("keeps a remembered scope however many other jobs emit before its first event", () => {
    // A queued PR review: its id is handed out, then 500+ other jobs run.
    rememberJobScope("prr-queued", "pr-review", "proj-1");
    for (let i = 0; i < 600; i += 1) NOOP_JOB_EMITTER.started("pr-review", `busy-${i}`, "proj-2");
    expect(getJobScope("prr-queued")).toEqual({ kind: "pr-review", projectId: "proj-1" });
  });

  it("bounds remembered scopes on their own cap", () => {
    rememberJobScope("first", "pr-review", "proj-1");
    for (let i = 0; i < 500; i += 1) rememberJobScope(`prr-${i}`, "pr-review", "proj-1");
    expect(getJobScope("first")).toBeUndefined();
    expect(getJobScope("prr-499")).toBeDefined();
  });

  it("is cleared by the test seam", () => {
    rememberJobScope("gone", "pr-review", "proj-1");
    NOOP_JOB_EMITTER.started("pr-review", "gone-too", "proj-1");
    _resetJobLifecycleMemory();
    expect(getJobScope("gone")).toBeUndefined();
    expect(getJobScope("gone-too")).toBeUndefined();
  });
});
