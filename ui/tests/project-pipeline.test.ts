/**
 * #29 (epic #26) — the project Overview reports each pipeline stage's state and
 * its primary action. These are the pure derivations behind that page.
 */
import { describe, it, expect } from "vitest";
import {
  derivePipelineStages,
  isFirstRun,
  isIngestRunning,
  FIRST_RUN_STEPS,
  type PipelineFacts,
  type PipelineStage,
} from "@/lib/project-pipeline";

const P = "p1";
const B = `/projects/${P}`;

function facts(over: Partial<PipelineFacts> = {}): PipelineFacts {
  return {
    repos: [],
    databases: 0,
    documents: { total: 0, items: [] },
    ingestInProgress: false,
    analyses: [],
    awaitingReview: null,
    docs: [],
    batches: [],
    ...over,
  };
}

function stage(f: PipelineFacts, id: PipelineStage["id"]): PipelineStage {
  const s = derivePipelineStages(P, f).find((x) => x.id === id);
  if (!s) throw new Error(`no stage ${id}`);
  return s;
}

const completed = {
  id: "a1",
  status: "completed",
  startedAt: "2026-09-01T10:00:00Z",
  completedAt: "2026-09-01T10:05:00Z",
};

describe("derivePipelineStages — order", () => {
  it("lists the six stages in pipeline order", () => {
    expect(derivePipelineStages(P, facts()).map((s) => s.id)).toEqual([
      "sources",
      "ingest",
      "analyze",
      "review",
      "docs",
      "publish",
    ]);
  });
});

describe("sources stage", () => {
  it("asks to connect a source when there is none", () => {
    const s = stage(facts(), "sources");
    expect(s.state).toBe("todo");
    expect(s.status).toMatch(/no sources/i);
    expect(s.action).toEqual({ label: "Connect a source", href: `${B}/connections` });
  });

  it("counts repositories, databases and documents", () => {
    const s = stage(
      facts({
        repos: [
          { status: "connected", lastIngestAt: null },
          { status: "connected", lastIngestAt: null },
        ],
        databases: 1,
        documents: { total: 14, items: [] },
      }),
      "sources",
    );
    expect(s.state).toBe("done");
    expect(s.status).toBe("2 repositories · 1 database · 14 documents");
    expect(s.action.label).toBe("Manage sources");
  });

  it("uses the singular for one of each", () => {
    const s = stage(
      facts({
        repos: [{ status: "connected", lastIngestAt: null }],
        documents: { total: 1, items: [] },
      }),
      "sources",
    );
    expect(s.status).toBe("1 repository · 1 document");
  });

  it("flags a connection in error", () => {
    const s = stage(
      facts({
        repos: [
          { status: "error", lastIngestAt: null },
          { status: "connected", lastIngestAt: null },
        ],
      }),
      "sources",
    );
    expect(s.state).toBe("attention");
    expect(s.status).toMatch(/1 connection has an error/);
  });
});

describe("ingest stage", () => {
  it("is to-do with nothing ingested", () => {
    const s = stage(facts(), "ingest");
    expect(s.state).toBe("todo");
    expect(s.status).toMatch(/nothing ingested/i);
    expect(s.action).toEqual({ label: "Ingest", href: `${B}/connections` });
  });

  it("is running while a live ingest reports progress", () => {
    const s = stage(facts({ ingestInProgress: true }), "ingest");
    expect(s.state).toBe("running");
    expect(s.status).toMatch(/ingesting/i);
  });

  it("is running while any document is still being processed", () => {
    const s = stage(
      facts({
        documents: {
          total: 3,
          items: [
            { status: "ready", chunkCount: 4 },
            { status: "processing", chunkCount: 0 },
            { status: "queued", chunkCount: 0 },
          ],
        },
      }),
      "ingest",
    );
    expect(s.state).toBe("running");
    expect(s.status).toMatch(/2 documents processing/);
  });

  it("reports ready documents and chunk counts", () => {
    const s = stage(
      facts({
        documents: {
          total: 2,
          items: [
            { status: "ready", chunkCount: 1000 },
            { status: "ready", chunkCount: 203 },
          ],
        },
      }),
      "ingest",
    );
    expect(s.state).toBe("done");
    expect(s.status).toContain("2 documents ready");
    expect(s.status).toContain("1,203 chunks");
  });

  it("omits the chunk total when only a page of documents was listed", () => {
    const s = stage(
      facts({ documents: { total: 40, items: [{ status: "ready", chunkCount: 5 }] } }),
      "ingest",
    );
    expect(s.status).not.toContain("chunks");
  });

  // Review of #63 — `GET /documents` returns one page (at most 100), and a
  // connected repository creates a document per file. A count taken from that
  // page is a lower bound, never the project's figure.
  it("reports the project's document total, not the page's ready count, when the list is partial", () => {
    const s = stage(
      facts({
        documents: {
          total: 1234,
          items: Array.from({ length: 100 }, () => ({ status: "ready", chunkCount: 3 })),
        },
      }),
      "ingest",
    );
    expect(s.state).toBe("done");
    expect(s.status).toContain("1,234 documents");
    expect(s.status).not.toMatch(/100 documents/);
    expect(s.status).not.toContain("ready");
    expect(s.status).not.toContain("chunks");
  });

  it("states failures and processing on a partial list as lower bounds", () => {
    const failed = stage(
      facts({
        documents: {
          total: 500,
          items: [
            { status: "failed", chunkCount: 0 },
            { status: "ready", chunkCount: 1 },
          ],
        },
      }),
      "ingest",
    );
    expect(failed.state).toBe("attention");
    expect(failed.status).toContain("500 documents");
    expect(failed.status).toContain("at least 1 document failed");

    const running = stage(
      facts({
        documents: {
          total: 500,
          items: [
            { status: "processing", chunkCount: 0 },
            { status: "queued", chunkCount: 0 },
          ],
        },
      }),
      "ingest",
    );
    expect(running.state).toBe("running");
    expect(running.status).toBe("Ingesting — at least 2 documents processing");
  });

  it("gives exact counts when every document is on the page", () => {
    const s = stage(
      facts({
        documents: {
          total: 3,
          items: [
            { status: "ready", chunkCount: 1 },
            { status: "ready", chunkCount: 1 },
            { status: "failed", chunkCount: 0 },
          ],
        },
      }),
      "ingest",
    );
    expect(s.status).toBe("2 documents ready · 2 chunks · 1 document failed");
  });

  it("counts a repository ingest as done and dates it", () => {
    const s = stage(
      facts({ repos: [{ status: "connected", lastIngestAt: "2026-09-02T08:00:00Z" }] }),
      "ingest",
    );
    expect(s.state).toBe("done");
    expect(s.status).toMatch(/repository last ingested/i);
  });

  it("flags failed documents", () => {
    const s = stage(
      facts({
        documents: {
          total: 2,
          items: [
            { status: "ready", chunkCount: 1 },
            { status: "failed", chunkCount: 0 },
          ],
        },
      }),
      "ingest",
    );
    expect(s.state).toBe("attention");
    expect(s.status).toMatch(/1 document failed/);
  });
});

describe("analyze stage", () => {
  it("asks to run the first analysis", () => {
    const s = stage(facts(), "analyze");
    expect(s.state).toBe("todo");
    expect(s.action).toEqual({ label: "Run analysis", href: `${B}/analysis` });
  });

  it.each(["running", "pending"])("is running when the latest analysis is %s", (status) => {
    const s = stage(
      facts({
        analyses: [{ id: "a2", status, startedAt: "2026-09-03T09:00:00Z", completedAt: null }],
      }),
      "analyze",
    );
    expect(s.state).toBe("running");
    expect(s.action).toEqual({ label: "View progress", href: `${B}/analysis?analysisId=a2` });
  });

  it("reports the last completed analysis", () => {
    const s = stage(facts({ analyses: [completed] }), "analyze");
    expect(s.state).toBe("done");
    expect(s.status).toMatch(/last analysis completed/i);
  });

  it("flags a failed latest analysis", () => {
    const s = stage(
      facts({
        analyses: [
          { id: "a3", status: "failed", startedAt: "2026-09-03T09:00:00Z", completedAt: null },
        ],
      }),
      "analyze",
    );
    expect(s.state).toBe("attention");
    expect(s.status).toMatch(/failed/i);
  });
});

describe("review stage", () => {
  it("waits on an analysis before there is anything to review", () => {
    const s = stage(facts(), "review");
    expect(s.state).toBe("todo");
    expect(s.status).toMatch(/run an analysis/i);
    expect(s.action.href).toBe(`${B}/requirements`);
  });

  it("names the number awaiting review and deep-links to that analysis", () => {
    const s = stage(facts({ analyses: [completed], awaitingReview: 12 }), "review");
    expect(s.state).toBe("attention");
    expect(s.status).toBe("12 requirements awaiting review");
    expect(s.action).toEqual({
      label: "Review 12 requirements",
      href: `${B}/analysis?analysisId=a1`,
    });
  });

  it("uses the singular for one requirement", () => {
    const s = stage(facts({ analyses: [completed], awaitingReview: 1 }), "review");
    expect(s.action.label).toBe("Review 1 requirement");
  });

  it("reviews the latest COMPLETED analysis, not a newer running one", () => {
    const s = stage(
      facts({
        analyses: [
          { id: "a9", status: "running", startedAt: "2026-09-04T00:00:00Z", completedAt: null },
          completed,
        ],
        awaitingReview: 3,
      }),
      "review",
    );
    expect(s.action.href).toBe(`${B}/analysis?analysisId=a1`);
  });

  it("is done when nothing is awaiting review", () => {
    const s = stage(facts({ analyses: [completed], awaitingReview: 0 }), "review");
    expect(s.state).toBe("done");
    expect(s.status).toMatch(/all requirements reviewed/i);
  });

  it("says it is checking while the count is unknown", () => {
    const s = stage(facts({ analyses: [completed], awaitingReview: null }), "review");
    expect(s.state).toBe("todo");
    expect(s.status).toMatch(/checking/i);
  });
});

// #66 — generated docs published back into the knowledge base and held for
// review keep `status = processing`, exactly as observed on a local install.
const quarantinedGeneratedDocs = [
  { status: "processing", indexState: "quarantined", chunkCount: 26 },
  { status: "processing", indexState: "quarantined", chunkCount: 58 },
  { status: "processing", indexState: "quarantined", chunkCount: 1 },
];

describe("quarantined documents (#66)", () => {
  it("leave the Ingest stage idle when they are the only non-ready documents", () => {
    const s = stage(
      facts({
        documents: {
          total: 4,
          items: [
            { status: "ready", indexState: "indexed", chunkCount: 4 },
            ...quarantinedGeneratedDocs,
          ],
        },
      }),
      "ingest",
    );
    expect(s.state).toBe("done");
    expect(s.status).not.toMatch(/ingesting|processing/i);
    expect(s.status).toBe("1 document ready · 4 chunks · 3 documents awaiting review");
  });

  it("do not hide a document that is really still processing", () => {
    const s = stage(
      facts({
        documents: {
          total: 4,
          items: [
            { status: "processing", indexState: "pending", chunkCount: 0 },
            ...quarantinedGeneratedDocs,
          ],
        },
      }),
      "ingest",
    );
    expect(s.state).toBe("running");
    expect(s.status).toMatch(/1 document processing/);
  });

  it("are counted under Review and linked to the quarantine queue", () => {
    const s = stage(
      facts({
        analyses: [completed],
        awaitingReview: 0,
        documents: { total: 3, items: quarantinedGeneratedDocs },
      }),
      "review",
    );
    expect(s.state).toBe("attention");
    expect(s.status).toBe("All requirements reviewed · 3 documents awaiting review in quarantine");
    expect(s.action).toEqual({
      label: "Review 3 quarantined documents",
      href: `${B}/settings#quarantine`,
    });
    expect(s.secondaryAction).toEqual({ label: "Open requirements", href: `${B}/requirements` });
  });

  it("keep requirements awaiting review as the primary action, quarantine second", () => {
    const s = stage(
      facts({
        analyses: [completed],
        awaitingReview: 2,
        documents: { total: 10, items: quarantinedGeneratedDocs.slice(0, 1) },
      }),
      "review",
    );
    expect(s.status).toBe(
      "2 requirements awaiting review · at least 1 document awaiting review in quarantine",
    );
    expect(s.action.href).toBe(`${B}/analysis?analysisId=a1`);
    expect(s.secondaryAction).toEqual({
      label: "Review 1 quarantined document",
      href: `${B}/settings#quarantine`,
    });
  });

  it("leave Review unchanged when nothing is quarantined", () => {
    const s = stage(facts({ analyses: [completed], awaitingReview: 0 }), "review");
    expect(s.secondaryAction).toBeUndefined();
    expect(s.state).toBe("done");
  });
});

describe("docs stage", () => {
  it("asks to generate docs when there are none", () => {
    const s = stage(facts(), "docs");
    expect(s.state).toBe("todo");
    expect(s.action).toEqual({ label: "Generate docs", href: `${B}/documentation` });
  });

  it.each(["generating", "pending"])("is running while a doc is %s", (status) => {
    const s = stage(facts({ docs: [{ status: "ready" }, { status }] }), "docs");
    expect(s.state).toBe("running");
    expect(s.status).toMatch(/generating 1 document/i);
  });

  it("counts generated documents", () => {
    const s = stage(facts({ docs: [{ status: "ready" }, { status: "degraded" }] }), "docs");
    expect(s.state).toBe("done");
    expect(s.status).toBe("2 documents generated");
  });

  it("flags a failed generation", () => {
    const s = stage(facts({ docs: [{ status: "ready" }, { status: "failed" }] }), "docs");
    expect(s.state).toBe("attention");
    expect(s.status).toMatch(/1 failed/);
  });
});

describe("publish stage", () => {
  const batch = {
    status: "completed",
    dryRun: true,
    publishedCount: 5,
    totalDrafts: 6,
    startedAt: "2026-09-05T10:00:00Z",
    completedAt: "2026-09-05T10:01:00Z",
  };

  // Review of #63 — `reader` has no `issue.preview`, so the batch list is not
  // theirs to read. "Nothing published yet" would be a claim they cannot know.
  it("says publish history is unavailable, rather than empty, when it cannot be read", () => {
    const s = stage(facts({ batches: null }), "publish");
    expect(s.state).toBe("todo");
    expect(s.status).toBe("Publish history is not available to your role");
    expect(s.status).not.toMatch(/nothing published/i);
  });

  it("asks to publish when nothing has been", () => {
    const s = stage(facts(), "publish");
    expect(s.state).toBe("todo");
    expect(s.action).toEqual({ label: "Publish issues", href: `${B}/publish` });
  });

  it("reports the latest batch, including dry runs", () => {
    const s = stage(facts({ batches: [batch] }), "publish");
    expect(s.state).toBe("done");
    expect(s.status).toMatch(/^Last publish \(dry run\) completed .* · 5 of 6 published$/);
  });

  it("is running while the latest batch runs", () => {
    const s = stage(
      facts({ batches: [{ ...batch, status: "running", dryRun: false, completedAt: null }] }),
      "publish",
    );
    expect(s.state).toBe("running");
    expect(s.status).toMatch(/^Publishing/);
  });

  it("flags a failed batch", () => {
    const s = stage(facts({ batches: [{ ...batch, status: "failed", dryRun: false }] }), "publish");
    expect(s.state).toBe("attention");
    expect(s.status).toMatch(/^Last publish failed/);
  });
});

describe("isIngestRunning", () => {
  // The shapes the server actually emits on `connector:progress` — see
  // server/src/lib/connectors/{connector-ingest,repo/repo-service,db/db-service}.ts
  // and server/src/routes/connectors.ts.
  const ev = (phase: string, extra: Record<string, unknown> = {}) => ({
    connectorId: "c1",
    phase,
    step: "s",
    ts: 1,
    ...extra,
  });

  it("is false with no progress", () => {
    expect(isIngestRunning({})).toBe(false);
  });

  it.each(["ingest", "deep-ingest"])("is true for a %s event", (phase) => {
    expect(isIngestRunning({ c1: ev(phase, { current: 1, total: 5 }) })).toBe(true);
  });

  it.each(["test", "metadata", "introspect"])(
    "ignores a count-less %s event, which the hook never clears",
    (phase) => {
      expect(isIngestRunning({ c1: ev(phase) })).toBe(false);
    },
  );

  it("is true when any connector is ingesting", () => {
    expect(isIngestRunning({ a: ev("test"), b: ev("deep-ingest", { current: 2, total: 5 }) })).toBe(
      true,
    );
  });
});

describe("isFirstRun", () => {
  it("treats unreadable publish history as none", () => {
    expect(isFirstRun(facts({ batches: null }))).toBe(true);
  });

  it("is true for a brand-new project", () => {
    expect(isFirstRun(facts())).toBe(true);
  });

  it("stays true after only connecting a source — the checklist guides the rest", () => {
    expect(isFirstRun(facts({ repos: [{ status: "connected", lastIngestAt: null }] }))).toBe(true);
  });

  it("is false once an analysis exists", () => {
    expect(isFirstRun(facts({ analyses: [completed] }))).toBe(false);
  });

  it("is false once anything has been published", () => {
    expect(
      isFirstRun(
        facts({
          batches: [
            {
              status: "completed",
              dryRun: true,
              publishedCount: 0,
              totalDrafts: 0,
              startedAt: "2026-09-05T10:00:00Z",
              completedAt: null,
            },
          ],
        }),
      ),
    ).toBe(false);
  });

  it("lists the five first-run steps in order, without docs", () => {
    expect(FIRST_RUN_STEPS).toEqual(["sources", "ingest", "analyze", "review", "publish"]);
  });
});
