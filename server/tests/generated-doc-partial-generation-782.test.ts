/**
 * #782 — a full-scope BRD ran for 77 minutes, wrote its sections and failed in
 * its last second: nothing was saved, the only explanation was "the details are
 * in the server log", and a regenerate started over.
 *
 * Drives the REAL `generateDocumentAsync` and holistic synthesis against an
 * in-memory `generated_documents` row; only I/O (DB, LLM, retrieval, socket
 * events) is faked. Every assertion reads the row back, as the UI does.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  doc: {} as Record<string, unknown>,
  versions: [] as Array<Record<string, unknown>>,
  symbols: [] as Array<Record<string, unknown>>,
  stream: vi.fn(),
  failIndexWarnings: false,
  failManifest: false,
  failAfterSynthesis: false,
  failCommit: false,
  changeInputs: false,
  // The run dies while writing this section: its failure escapes the
  // section's own handler, as a lost process or a fatal error would.
  crashIn: null as string | null,
  // #855 / #856 — runs inside a section's model call, before it answers.
  duringSection: null as null | ((label: string, signal?: AbortSignal) => Promise<void> | void),
  // #855 — usage every model call reports.
  usage: null as null | { promptTokens: number; completionTokens: number; totalTokens: number },
}));

vi.mock("../src/lib/prisma.js", () => {
  const prisma = {
    project: {
      findFirst: vi.fn(async () => ({ id: "p", name: "Project", description: "System" })),
      findUnique: vi.fn(async () => ({ name: "Project" })),
    },
    user: {
      findFirst: vi.fn(async () => ({
        id: "u",
        username: "user",
        roles: [{ role: { key: "admin" } }],
        workspaceMemberships: [],
      })),
    },
    repoConnection: {
      findUnique: vi.fn(async ({ where }) => ({ id: where.id, projectId: "p" })),
      findFirst: vi.fn(async ({ where }) => (where.projectId === "p" ? { id: where.id } : null)),
    },
    codeGraph: {
      findFirst: vi.fn(async ({ where }) => ({ id: `g-${where.repoConnectionId}` })),
      findMany: vi.fn(async () => [
        {
          id: "g-r",
          commitSha: "sha",
          repoConnection: { id: "r", projectId: "p", deletedAt: null },
        },
      ]),
    },
    codeSymbol: {
      findMany: vi.fn(async (args: { select?: Record<string, unknown> }) => {
        // The first read after synthesis returned (the code-graph hash).
        if (state.failAfterSynthesis && args.select?.contentHash) {
          throw new TypeError("Cannot read properties of undefined (reading 'secret-path')");
        }
        if (state.changeInputs && args.select?.contentHash) {
          state.symbols = state.symbols.map((s) => ({ ...s, contentHash: `${s.contentHash}x` }));
        }
        return state.symbols;
      }),
      groupBy: vi.fn(async () => [
        { codeGraphId: "g-r", filePath: "src/api.ts", _count: { _all: state.symbols.length } },
      ]),
    },
    codeEdge: { findMany: vi.fn(async () => []) },
    knowledgeChunk: { findMany: vi.fn(async () => []) },
    finding: { findMany: vi.fn(async () => []) },
    docsGenFactCache: { findUnique: vi.fn(async () => null), upsert: vi.fn(async () => ({})) },
    generatedDocument: {
      findFirst: vi.fn(async ({ where }) =>
        state.doc.deletedAt || where.id !== state.doc.id || where.projectId !== state.doc.projectId
          ? null
          : { ...state.doc },
      ),
      updateMany: vi.fn(async ({ where, data }) => {
        // The publishing commit (it alone clears the checkpoint), not a salvage.
        if (state.failCommit && data.content && Object.hasOwn(data, "generationCheckpoint")) {
          throw new Error("commit failed: disk I/O error at /var/lib/metis/dev.db");
        }
        if (
          state.doc.deletedAt ||
          (Object.hasOwn(where, "codeGraphHash") &&
            state.doc.codeGraphHash !== where.codeGraphHash) ||
          (where.status && state.doc.status !== where.status) ||
          (where.updatedAt &&
            new Date(state.doc.updatedAt as Date).getTime() !== where.updatedAt.getTime()) ||
          (where.OR && state.doc.status === "generating")
        )
          return { count: 0 };
        Object.assign(state.doc, data, { updatedAt: new Date() });
        return { count: 1 };
      }),
    },
    generatedDocumentVersion: {
      findFirst: vi.fn(async () => state.versions.at(-1) ?? null),
      create: vi.fn(async ({ data }) => {
        state.versions.push(data);
        return data;
      }),
    },
    task: {
      upsert: vi.fn(async ({ create }) => ({ ...create, status: "pending" })),
      findUnique: vi.fn(async () => null),
    },
    auditLog: { create: vi.fn(async () => ({})) },
    $transaction: vi.fn(async (fn) => fn(prisma)),
  };
  return { prisma, Prisma: { DbNull: null } };
});
vi.mock("../src/lib/ai/index.js", () => ({
  loadAIConfig: () => ({ provider: "test", model: "test-model" }),
  buildProvider: () => ({
    key: "test",
    model: "test-model",
    offline: false,
    stream: state.stream,
    complete: vi.fn(async () => ({ content: '{"claims":[]}' })),
    chat: vi.fn(async () => ({ content: '{"claims":[]}' })),
  }),
}));
vi.mock("../src/lib/ai/config.js", () => ({
  loadAIConfig: () => ({ provider: "test", model: "test-model" }),
}));
vi.mock("../src/lib/rag/knowledge-service.js", () => ({
  getKnowledgeService: () => ({ search: vi.fn(async () => ({ hits: [] })) }),
}));
vi.mock("../src/lib/analysis/analysis-service.js", () => ({
  getLatestWebResearch: vi.fn(async () => ({ digests: [] })),
}));
vi.mock("../src/lib/docs-gen/generated-doc-publication.js", () => ({
  GENERATED_DOC_PUBLICATION_TASK_TYPE: "publish-generated-document",
  enqueueGeneratedDocPublication: vi.fn(),
  publishGeneratedDocRevision: vi.fn(),
  settleCancelledGeneratedDocPublication: vi.fn(),
  enqueueGeneratedDocDeletion: vi.fn(),
  generatedDocSyntheticDocumentId: (id: string) => `gendoc-${id}`,
}));
vi.mock("../src/lib/docs-gen/generated-doc-outbox.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/docs-gen/generated-doc-outbox.js")>()),
  dispatchGeneratedDocTask: vi.fn(async () => undefined),
}));
vi.mock("../src/lib/connectors/source-ingest-state.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/lib/connectors/source-ingest-state.js")>();
  return {
    ...actual,
    repositoryIndexWarnings: vi.fn(async () => {
      if (state.failIndexWarnings) throw new RangeError("Invalid array length");
      return [];
    }),
  };
});
// The provenance manifest is built inside synthesis, after the last section:
// a schema rejection there is the walkthrough's shape (the final section's
// grounding call, then failure 0.6 s later).
vi.mock("../src/lib/docs-gen/generated-doc-provenance.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/lib/docs-gen/generated-doc-provenance.js")>();
  return {
    ...actual,
    buildGeneratedDocVersionManifest: vi.fn(
      (...args: Parameters<typeof actual.buildGeneratedDocVersionManifest>) => {
        if (state.failManifest) {
          const err = new Error("label: String must contain at least 1 character(s)");
          err.name = "ZodError";
          throw err;
        }
        return actual.buildGeneratedDocVersionManifest(...args);
      },
    ),
  };
});
vi.mock("../src/lib/docs-gen/generation-failure-message.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/lib/docs-gen/generation-failure-message.js")>();
  return {
    ...actual,
    // First consulted by the failed section's own handler; throwing there once
    // is what takes the whole run down mid-section.
    generationFailureMessage: vi.fn((err: unknown) => {
      if (state.crashIn) {
        state.crashIn = null;
        throw new Error("run lost mid-section");
      }
      return actual.generationFailureMessage(err);
    }),
  };
});
// #855 — every recorded model call, including the estimate for an aborted one.
const recordUsage = vi.hoisted(() =>
  vi.fn(() => ({ totalTokens: 0, costCents: null, persisted: Promise.resolve() })),
);
vi.mock("../src/lib/finops/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/finops/index.js")>()),
  recordUsage,
}));
vi.mock("../src/lib/logger.js", () => ({
  createChildLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("../src/lib/socket/job-events.js", () => ({
  jobEvents: {
    started: vi.fn(),
    completed: vi.fn(),
    failed: vi.fn(),
    progress: vi.fn(),
    docSection: vi.fn(),
  },
  genericFailureMessage: () => "failed",
}));

import { generateDocumentAsync } from "../src/routes/generated-docs.js";
import { stopGeneration } from "../src/lib/docs-gen/generation-control.js";
import { prisma } from "../src/lib/prisma.js";
import { resolveEvidencePolicy } from "../src/lib/docs-gen/evidence-policy.js";
import { captureGenerationInputs } from "../src/lib/docs-gen/generation-inputs.js";
import { jobEvents } from "../src/lib/socket/job-events.js";
import { checkpointSectionRecords } from "../src/lib/docs-gen/section-reuse.js";
import { sectionGroupsFor } from "../src/lib/docs-gen/holistic-synthesizer.js";
import {
  GENERATION_CANCELLED_MESSAGE,
  GENERATION_FAILED_MESSAGE,
  GENERATION_INPUTS_CHANGED_MESSAGE,
} from "../src/lib/docs-gen/generation-failure-message.js";

const GROUPS = sectionGroupsFor("architecture");
const sectionCalls = () =>
  state.stream.mock.calls.filter(([messages]) =>
    /Section group: \*\*/.test(String((messages as Array<{ content: string }>).at(-1)?.content)),
  ).length;
const warnings = () => state.doc.warnings as Array<Record<string, unknown>>;
const cause = () => warnings().find((w) => typeof w.stage === "string");
const checkpointWrites = () =>
  vi
    .mocked(prisma.generatedDocument.updateMany)
    .mock.calls.filter(([args]) => Object.keys(args.data).join() === "generationCheckpoint");
const checkpointIds = () =>
  (state.doc.generationCheckpoint as { records: Array<{ sectionId: string }> }).records.map(
    (r) => r.sectionId,
  );

beforeEach(() => {
  vi.clearAllMocks();
  state.versions.length = 0;
  state.failIndexWarnings = false;
  state.failManifest = false;
  state.failAfterSynthesis = false;
  state.failCommit = false;
  state.changeInputs = false;
  state.crashIn = null;
  state.doc = {
    id: "d",
    projectId: "p",
    title: "Architecture",
    scope: "repository",
    scopeFilter: JSON.stringify({ repoConnectorId: "r", docType: "architecture" }),
    evidencePolicy: JSON.stringify({
      version: 1,
      principal: { kind: "initiating-user", userId: "u" },
      sharedDocumentIds: [],
      allowWebResearch: false,
    }),
    autoUpdate: false,
    status: "pending",
    content: "",
    codeGraphHash: null,
    generationCheckpoint: null,
    deletedAt: null,
    updatedAt: new Date(),
  };
  state.symbols = Array.from({ length: 30 }, (_, i) => ({
    id: `s${i}`,
    projectId: "p",
    codeGraphId: "g-r",
    graph: { repoConnectionId: "r" },
    filePath: "src/api.ts",
    qualifiedName: `Api.fn${i}`,
    kind: i === 0 ? "class" : "method",
    contentHash: `${i}`,
    startLine: i + 1,
    endLine: i + 2,
    language: "ts",
    source: null,
  }));
  state.duringSection = null;
  state.usage = null;
  recordUsage.mockClear();
  state.stream.mockImplementation(async function* (messages, opts?: { signal?: AbortSignal }) {
    const user = messages.at(-1).content as string;
    const label = user.match(/Section group: \*\*(.+?)\*\*/)?.[1];
    if (label && label === state.crashIn) throw new Error("provider connection reset");
    if (label && state.duringSection) await state.duringSection(label, opts?.signal);
    if (state.usage) yield { type: "usage", usage: state.usage };
    yield {
      type: "delta",
      content: label
        ? `## ${label}\n\nThe API validates requests.\n`
        : "PURPOSE\nAn API module.\nRULES\n- Requests are validated.\n",
    };
    yield { type: "done" };
  });
  for (const key of ["BEDROCK_GATEWAY_URL", "BEDROCK_BASE_URL", "DOCS_GEN_PHASE2_ROUTING"])
    vi.stubEnv(key, "");
});

describe("#782 — every finished section is checkpointed on the document", () => {
  it("writes the checkpoint after each section, and clears it on publish", async () => {
    const { prisma } = await import("../src/lib/prisma.js");
    await generateDocumentAsync("d", "p");

    // Published (this fixture's sections carry ordinary grounding warnings).
    expect(state.versions).toHaveLength(1);
    expect(state.doc.generationCheckpoint).toBeNull();
    const writes = vi
      .mocked(prisma.generatedDocument.updateMany)
      .mock.calls.map(([args]) => args as { where: Record<string, unknown>; data: object })
      .filter((args) => Object.keys(args.data).join() === "generationCheckpoint");
    // One write per section, each holding every section finished so far.
    expect(writes).toHaveLength(GROUPS.length);
    writes.forEach((w, i) => {
      const saved = (w.data as { generationCheckpoint: { records: unknown[] } })
        .generationCheckpoint;
      expect(saved.records).toHaveLength(i + 1);
      // Only while this run holds its claim.
      expect(w.where.codeGraphHash).toMatch(/^regenerating:/);
    });
  });
});

describe("#782 — a late failure keeps what was finished", () => {
  it("keeps the assembled document as degraded when it fails after synthesis", async () => {
    state.failAfterSynthesis = true;
    await generateDocumentAsync("d", "p");

    expect(state.doc.status).toBe("degraded");
    for (const group of GROUPS) expect(state.doc.content).toContain(`## ${group.label}`);
    // The assembled document itself (its header and footer), not the
    // fallback rebuilt from checkpointed sections.
    expect(state.doc.content).not.toContain("Incomplete document");
    expect(state.doc.content).toContain("auto-generated on");
    expect(state.doc.errorMessage).toBeNull();
    // The claim is released, never left pointing at a dead run.
    expect(state.doc.codeGraphHash).toBeNull();
    expect(cause()).toMatchObject({
      kind: "section-failed",
      section: "Document",
      stage: "assembly",
      errorClass: "TypeError",
      severity: "error",
      detailSafe: true,
    });
    // Never the exception's own text.
    expect(JSON.stringify(state.doc.warnings)).not.toContain("secret-path");
    expect(cause()!.message).toContain(GENERATION_FAILED_MESSAGE);
    // Not a version: nothing is published from a run that did not finish.
    expect(state.versions).toHaveLength(0);
    expect(jobEvents.completed).toHaveBeenCalledOnce();
    expect(jobEvents.failed).not.toHaveBeenCalled();
    // The checkpoint stays, so a regenerate can finish the job.
    expect(
      checkpointSectionRecords(
        state.doc.generationCheckpoint,
        GROUPS.map((g) => g.id),
        false,
      ).size,
    ).toBe(GROUPS.length);
  });

  it("assembles the checkpointed sections when the document itself was never assembled", async () => {
    state.failIndexWarnings = true;
    await generateDocumentAsync("d", "p");

    expect(state.doc.status).toBe("degraded");
    const content = String(state.doc.content);
    expect(content).toMatch(/^# Architecture\n/);
    expect(content).toContain("Incomplete document");
    for (const group of GROUPS) expect(content).toContain(`## ${group.label}`);
    expect(cause()).toMatchObject({ stage: "assembly", errorClass: "RangeError" });
    expect(String(cause()!.message)).not.toContain("Invalid array length");
  });

  it("a failure inside synthesis after the last section names assembly, not that section", async () => {
    state.failManifest = true;
    await generateDocumentAsync("d", "p");

    expect(state.doc.status).toBe("degraded");
    for (const group of GROUPS) expect(state.doc.content).toContain(`## ${group.label}`);
    expect(cause()).toMatchObject({
      section: "Document",
      stage: "assembly",
      errorClass: "ZodError",
    });
    expect(String(cause()!.message)).not.toContain("at least 1 character");
  });

  it("never overwrites a published version with a partial one", async () => {
    state.versions.push({ version: 1, provenanceManifest: null });
    state.doc.status = "failed";
    state.doc.content = "# Published v1";
    state.failAfterSynthesis = true;
    await generateDocumentAsync("d", "p");

    expect(state.doc.status).toBe("failed");
    expect(state.doc.content).toBe("# Published v1");
    expect(state.doc.errorMessage).toBe(GENERATION_FAILED_MESSAGE);
    // The cause is still on the document, where the UI can show it.
    expect(warnings()).toEqual([expect.objectContaining({ stage: "assembly" })]);
    expect(state.doc.generationCheckpoint).not.toBeNull();
    expect(jobEvents.failed).toHaveBeenCalledOnce();
  });

  it("never salvages an automatic regeneration, even with no published version", async () => {
    // `expectedVersion: 0` is how an automatic run reaches a never-published row.
    state.doc.autoUpdate = true;
    state.doc.status = "failed";
    const doc = state.doc as unknown as Parameters<typeof resolveEvidencePolicy>[0] &
      Parameters<typeof captureGenerationInputs>[0];
    const { fingerprint } = await captureGenerationInputs(doc, await resolveEvidencePolicy(doc));
    state.failAfterSynthesis = true;

    await expect(
      generateDocumentAsync("d", "p", {
        projectId: "p",
        generatedDocumentId: "d",
        expectedVersion: 0,
        fingerprint,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(TypeError);

    // It got as far as a late failure: every section was written.
    expect(sectionCalls()).toBe(GROUPS.length);
    expect(state.doc.status).toBe("failed");
    expect(state.doc.content).toBe("");
    expect(warnings()).toEqual([expect.objectContaining({ stage: "assembly" })]);
    expect(jobEvents.completed).not.toHaveBeenCalled();
  });

  it("#857 — keeps the written document when the commit failed; every section stays checkpointed", async () => {
    state.failCommit = true;
    await generateDocumentAsync("d", "p");

    // An unpublished draft: no version, so nothing is indexed or published.
    expect(state.doc.status).toBe("degraded");
    expect(state.versions).toHaveLength(0);
    for (const group of GROUPS) expect(state.doc.content).toContain(`## ${group.label}`);
    expect(cause()).toMatchObject({ stage: "commit", errorClass: "Error" });
    expect(JSON.stringify(state.doc.warnings)).not.toContain("/var/lib");
    expect(
      checkpointSectionRecords(
        state.doc.generationCheckpoint,
        GROUPS.map((g) => g.id),
        false,
      ).size,
    ).toBe(GROUPS.length);
  });

  it("#857 — keeps a run refused at the commit fence as an unpublished draft, and says why", async () => {
    // Run 3: the first BRD attempt finished every section, then the fence found
    // its inputs changed. It saved nothing, and the regenerate started over.
    state.changeInputs = true;
    await generateDocumentAsync("d", "p");

    expect(state.doc.status).toBe("degraded");
    expect(state.versions).toHaveLength(0);
    for (const group of GROUPS) expect(state.doc.content).toContain(`## ${group.label}`);
    expect(cause()).toMatchObject({ stage: "commit", errorClass: "UnpublishableGenerationError" });
    expect(String(cause()!.message)).toContain("sources changed");
    expect(String(cause()!.message)).toContain("not published");
    expect(jobEvents.completed).toHaveBeenCalledWith(
      "doc-generation",
      "d",
      "p",
      expect.stringContaining("not published"),
    );

    // Regenerate: every section whose own inputs still match is reused.
    state.changeInputs = false;
    state.doc.status = "pending";
    state.stream.mockClear();
    await generateDocumentAsync("d", "p");
    expect(sectionCalls()).toBe(0);
    expect(state.versions).toHaveLength(1);
    expect(state.versions[0].diffSummary).toBe(
      `Initial generation, resumed: Reused ${GROUPS.length} finished sections`,
    );
  });

  it("still fails a run with a published version, keeping that version's content", async () => {
    state.versions.push({ version: 1, provenanceManifest: null });
    state.doc.status = "ready";
    state.doc.content = "# Published v1";
    state.changeInputs = true;
    await generateDocumentAsync("d", "p");

    expect(state.doc.status).toBe("failed");
    expect(state.doc.content).toBe("# Published v1");
    expect(state.doc.errorMessage).toBe(GENERATION_INPUTS_CHANGED_MESSAGE);
  });
});

describe("#782 — regenerate resumes from the checkpoint", () => {
  it("reuses every checkpointed section instead of writing it again", async () => {
    state.failAfterSynthesis = true;
    await generateDocumentAsync("d", "p");
    expect(sectionCalls()).toBe(GROUPS.length);

    state.failAfterSynthesis = false;
    state.doc.status = "pending";
    state.stream.mockClear();
    vi.mocked(prisma.generatedDocument.updateMany).mockClear();
    await generateDocumentAsync("d", "p");

    expect(state.versions).toHaveLength(1);
    expect(sectionCalls()).toBe(0);
    // A reused section is checkpointed too, one write each, so a resumed run
    // that fails later still has every section it carried forward.
    expect(checkpointWrites()).toHaveLength(GROUPS.length);
    for (const group of GROUPS) expect(state.doc.content).toContain(`## ${group.label}`);
    expect(state.doc.generationCheckpoint).toBeNull();
    expect(state.versions).toHaveLength(1);
  });

  it("writes again only the sections whose inputs changed", async () => {
    state.failAfterSynthesis = true;
    await generateDocumentAsync("d", "p");
    const saved = state.doc.generationCheckpoint as { records: Array<{ inputs: object }> };
    // Invalidate one record's inputs, as a changed source would.
    saved.records[0] = {
      ...saved.records[0],
      inputs: { ...saved.records[0].inputs, facts: "0".repeat(64) },
    };

    state.failAfterSynthesis = false;
    state.doc.status = "pending";
    state.stream.mockClear();
    await generateDocumentAsync("d", "p");

    expect(state.versions).toHaveLength(1);
    expect(sectionCalls()).toBe(1);
  });
});

describe("#782 — a resumed run that fails again keeps every finished section", () => {
  const BRD = sectionGroupsFor("business-requirements");
  // Sections 1–5 of the BRD's 7.
  const firstFive = BRD.slice(0, 5);

  beforeEach(() => {
    state.doc.title = "Business Requirements";
    state.doc.scopeFilter = JSON.stringify({
      repoConnectorId: "r",
      docType: "business-requirements",
    });
  });

  it("keeps the sections it had not reached when a changed section's rewrite fails", async () => {
    // Run 1 finishes sections 1–5, then dies writing section 6.
    state.crashIn = BRD[5].label;
    await generateDocumentAsync("d", "p");
    expect(state.doc.status).toBe("degraded");
    expect(checkpointIds()).toEqual(firstFive.map((g) => g.id));

    // An ingest changes section 3's inputs.
    const saved = state.doc.generationCheckpoint as { records: Array<{ inputs: object }> };
    saved.records[2] = {
      ...saved.records[2],
      inputs: { ...saved.records[2].inputs, facts: "0".repeat(64) },
    };

    // Run 2 reuses 1–2, then dies rewriting section 3.
    state.crashIn = BRD[2].label;
    state.stream.mockClear();
    await generateDocumentAsync("d", "p");
    expect(sectionCalls()).toBe(1);

    // Sections 4 and 5 are still stored, and the stale section 3 is not.
    const kept = [BRD[0], BRD[1], BRD[3], BRD[4]];
    expect(checkpointIds()).toEqual(kept.map((g) => g.id));
    expect(
      checkpointSectionRecords(
        state.doc.generationCheckpoint,
        BRD.map((g) => g.id),
        false,
      ).size,
    ).toBe(4);
    // ...and the partial document shows all four.
    expect(state.doc.status).toBe("degraded");
    const content = String(state.doc.content);
    expect(content).toContain("Incomplete document");
    expect(content).toContain("4 finished sections are shown");
    for (const group of kept) expect(content).toContain(`## ${group.label}`);
    expect(content).not.toContain(`## ${BRD[2].label}`);
    expect(cause()).toMatchObject({ stage: "sections", section: BRD[2].label });

    // Run 3 resumes: only sections 3, 6 and 7 are written.
    state.stream.mockClear();
    await generateDocumentAsync("d", "p");
    expect(sectionCalls()).toBe(3);
    expect(state.versions).toHaveLength(1);
  });
});

/** Wait, inside a model call, for the run to abort it — as a real provider would. */
const abortedBy = (signal?: AbortSignal) =>
  new Promise<never>((_, reject) => {
    const abort = () =>
      reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" }));
    if (signal?.aborted) abort();
    signal?.addEventListener("abort", abort);
  });

describe("#855 — cancel", () => {
  it("aborts the in-flight call, records its spend, keeps what was finished and says cancelled", async () => {
    let inFlight: AbortSignal | undefined;
    state.duringSection = async (label, signal) => {
      if (label !== GROUPS[1].label) return;
      inFlight = signal;
      // What POST /:docId/cancel does: mark the row, stop the run.
      state.doc.status = "cancelling";
      expect(stopGeneration("d", "aborted")).toBe(1);
      await abortedBy(signal);
    };
    await generateDocumentAsync("d", "p");

    expect(inFlight?.aborted).toBe(true);
    // No section after the cancelled one was started.
    expect(sectionCalls()).toBe(2);
    expect(state.doc.status).toBe("cancelled");
    expect(state.doc.errorMessage).toBe(GENERATION_CANCELLED_MESSAGE);
    expect(state.doc.codeGraphHash).toBeNull();
    expect(state.versions).toHaveLength(0);
    const content = String(state.doc.content);
    expect(content).toContain("Incomplete document");
    expect(content).toContain(`## ${GROUPS[0].label}`);
    expect(content).not.toContain(`## ${GROUPS[1].label}`);
    expect(cause()).toMatchObject({
      stage: "sections",
      errorClass: "UnpublishableGenerationError",
    });
    expect(String(cause()!.message)).toContain("cancelled");
    expect(checkpointIds()).toEqual([GROUPS[0].id]);
    // The aborted call is billed too: its spend is estimated and recorded.
    expect(recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ agentStep: "docs-gen-aborted", projectId: "p" }),
    );
    expect(jobEvents.completed).toHaveBeenCalledWith(
      "doc-generation",
      "d",
      "p",
      "Generation cancelled",
    );
    expect(jobEvents.failed).not.toHaveBeenCalled();
    // The run is no longer registered.
    expect(stopGeneration("d", "aborted")).toBe(0);

    // Regenerate resumes from the checkpoint.
    state.duringSection = null;
    state.doc.status = "pending";
    state.stream.mockClear();
    await generateDocumentAsync("d", "p");
    expect(sectionCalls()).toBe(GROUPS.length - 1);
    expect(state.versions).toHaveLength(1);
  });

  it("stops a run cancelled from another replica at the next section", async () => {
    state.duringSection = (label) => {
      // Only the row changes: this process holds no stop for it.
      if (label === GROUPS[1].label) state.doc.status = "cancelling";
    };
    await generateDocumentAsync("d", "p");

    expect(sectionCalls()).toBe(2);
    expect(state.doc.status).toBe("cancelled");
    expect(checkpointIds()).toEqual([GROUPS[0].id, GROUPS[1].id]);
  });

  it("never publishes over a cancel that lands during the last section", async () => {
    state.duringSection = (label) => {
      if (label === GROUPS.at(-1)!.label) state.doc.status = "cancelling";
    };
    await generateDocumentAsync("d", "p");

    expect(state.versions).toHaveLength(0);
    expect(state.doc.status).toBe("cancelled");
    // Every section was written, and every one is kept.
    for (const group of GROUPS) expect(state.doc.content).toContain(`## ${group.label}`);
  });

  it("never publishes over a cancel that lands after assembly, before the commit", async () => {
    // The commit fence's own read is the last chance to see it: the cancel lands
    // after the pre-assembly check (the first read once every section is done).
    const findFirst = vi.mocked(prisma.generatedDocument.findFirst);
    const original = findFirst.getMockImplementation()!;
    let readsAfterSections = 0;
    findFirst.mockImplementation(async (args) => {
      if (sectionCalls() === GROUPS.length && ++readsAfterSections === 2)
        state.doc.status = "cancelling";
      return original(args);
    });
    try {
      await generateDocumentAsync("d", "p");
    } finally {
      findFirst.mockImplementation(original);
    }

    expect(state.versions).toHaveLength(0);
    expect(state.doc.status).toBe("cancelled");
    expect(String(state.doc.content)).toContain("auto-generated on");
  });

  it("does nothing when the document was cancelled before the run read it", async () => {
    state.doc.status = "cancelled";
    await generateDocumentAsync("d", "p");
    expect(state.stream).not.toHaveBeenCalled();
    expect(state.doc.status).toBe("cancelled");
  });
});

describe("#855 — delete stops the spend", () => {
  it("aborts the in-flight call and writes nothing more", async () => {
    let inFlight: AbortSignal | undefined;
    state.duringSection = async (label, signal) => {
      if (label !== GROUPS[1].label) return;
      inFlight = signal;
      // What DELETE /:docId does after its soft-delete commits.
      state.doc.deletedAt = new Date();
      stopGeneration("d", "superseded");
      await abortedBy(signal);
    };
    await generateDocumentAsync("d", "p");

    expect(inFlight?.aborted).toBe(true);
    expect(sectionCalls()).toBe(2);
    expect(state.versions).toHaveLength(0);
    expect(jobEvents.failed).not.toHaveBeenCalled();
    expect(jobEvents.completed).not.toHaveBeenCalled();
  });
});

describe("#855 — the per-document cost ceiling", () => {
  it("stops the run at its token ceiling and keeps what was finished", async () => {
    vi.stubEnv("DOCS_GEN_MAX_RUN_TOKENS", "2500");
    state.usage = { promptTokens: 500, completionTokens: 500, totalTokens: 1_000 };
    await generateDocumentAsync("d", "p");
    vi.unstubAllEnvs();

    expect(sectionCalls()).toBeGreaterThan(0);
    expect(sectionCalls()).toBeLessThan(GROUPS.length);
    expect(state.doc.status).toBe("degraded");
    expect(state.versions).toHaveLength(0);
    expect(String(cause()!.message)).toContain("cost ceiling");
    expect(jobEvents.completed).toHaveBeenCalledWith(
      "doc-generation",
      "d",
      "p",
      expect.stringContaining("cost ceiling"),
    );
  });
});

describe("#856 — inputs are checked between sections, not only at the commit fence", () => {
  it("stops a run whose sources changed mid-run before it writes the next section", async () => {
    state.duringSection = (label) => {
      // A refresh lands while section 2 is being written.
      if (label === GROUPS[1].label)
        state.symbols = state.symbols.map((s) => ({ ...s, contentHash: `${s.contentHash}-new` }));
    };
    await generateDocumentAsync("d", "p");

    expect(sectionCalls()).toBe(2);
    expect(state.doc.status).toBe("degraded");
    expect(state.versions).toHaveLength(0);
    expect(cause()).toMatchObject({
      stage: "sections",
      section: "Document",
      errorClass: "UnpublishableGenerationError",
    });
    expect(String(cause()!.message)).toContain("sources changed");
    expect(checkpointIds()).toEqual([GROUPS[0].id, GROUPS[1].id]);
  });

  it("does not stop a run whose sources did not change", async () => {
    state.duringSection = () => {
      // A same-SHA refresh that recreated identical rows: new ids, same content.
      state.symbols = state.symbols.map((s) => ({ ...s, id: `${s.id}-recreated` }));
    };
    await generateDocumentAsync("d", "p");

    expect(sectionCalls()).toBe(GROUPS.length);
    expect(state.versions).toHaveLength(1);
  });
});

describe("#857 — a resumed run says which stored sections were stale, and why", () => {
  it("records the reused and rewritten sections on the version", async () => {
    state.failAfterSynthesis = true;
    await generateDocumentAsync("d", "p");
    const saved = state.doc.generationCheckpoint as { records: Array<{ inputs: object }> };
    saved.records[1] = {
      ...saved.records[1],
      inputs: { ...saved.records[1].inputs, facts: "0".repeat(64), flow: "1".repeat(64) },
    };

    state.failAfterSynthesis = false;
    state.doc.status = "pending";
    await generateDocumentAsync("d", "p");

    expect(state.versions[0].diffSummary).toBe(
      `Initial generation, resumed: Reused ${GROUPS.length - 1} finished sections; rewrote 1 whose inputs changed: ${GROUPS[1].label} (facts, flow)`,
    );
  });
});
