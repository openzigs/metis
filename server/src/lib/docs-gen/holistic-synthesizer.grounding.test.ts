/**
 * Integration tests for grounding injection (#222), degraded-output warnings
 * (#225), and entailment-based faithfulness scoring (#273) in the holistic
 * synthesizer.
 *
 * The provider factory (`../ai/index.js`) and prisma are mocked so we can drive
 * the ONLINE synthesis path deterministically (the default offline stub would
 * short-circuit before sections are generated).
 *
 * #273 — the per-section verification now makes TWO `provider.chat` calls: the
 * claim EXTRACTOR (decompose → atomic claims) and the faithfulness JUDGE
 * (entailment verdicts over the source TEXT). The mock distinguishes them by
 * prompt shape: the judge prompt contains "SOURCE EVIDENCE".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import type { AIProvider, ChatChunk } from "../ai/types.js";
import { buildGroundingContext } from "./grounding/grounding-context.js";

// ── prisma mock ─────────────────────────────────────────────────────────
const mockPrisma = {
  project: { findUnique: vi.fn(), findFirst: vi.fn() },
  user: { findFirst: vi.fn() },
  knowledgeChunk: { findMany: vi.fn() },
  generatedDocument: { findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  generatedDocumentVersion: { findFirst: vi.fn(), create: vi.fn() },
  task: { upsert: vi.fn(async ({ create }) => create), findUnique: vi.fn(async () => null) },
  codeSymbol: { count: vi.fn(), groupBy: vi.fn(), findMany: vi.fn() },
  codeEdge: { findMany: vi.fn() },
  codeGraph: { findFirst: vi.fn(), findMany: vi.fn() },
  finding: { findMany: vi.fn() },
  repoConnection: { findFirst: vi.fn() },
  docsGenFactCache: { findUnique: vi.fn(), upsert: vi.fn() },
  $transaction: vi.fn(),
};

// #330 — the happy path reads real source per module before extracting facts.
// Provide readable source so the synthesizer does NOT (correctly) raise a
// `source-unavailable` warning; tests that want the missing-source case can
// override `readFile` to reject.
vi.mock("node:fs/promises", () => ({
  realpath: vi.fn(async (p: string) => path.resolve(p)),
  readFile: vi.fn().mockResolvedValue("export class A { m1() { return 1; } }\n"),
  readdir: vi.fn().mockResolvedValue([]),
}));

vi.mock("../prisma.js", () => ({
  Prisma: { DbNull: "__DbNull__" },
  prisma: {
    project: {
      findUnique: (...a: unknown[]) => mockPrisma.project.findUnique(...a),
      findFirst: (...a: unknown[]) => mockPrisma.project.findFirst(...a),
    },
    user: { findFirst: (...a: unknown[]) => mockPrisma.user.findFirst(...a) },
    knowledgeChunk: { findMany: (...a: unknown[]) => mockPrisma.knowledgeChunk.findMany(...a) },
    generatedDocument: {
      findFirst: (...a: unknown[]) => mockPrisma.generatedDocument.findFirst(...a),
      update: (...a: unknown[]) => mockPrisma.generatedDocument.update(...a),
      updateMany: (...a: unknown[]) => mockPrisma.generatedDocument.updateMany(...a),
    },
    generatedDocumentVersion: {
      findFirst: (...a: unknown[]) => mockPrisma.generatedDocumentVersion.findFirst(...a),
      create: (...a: unknown[]) => mockPrisma.generatedDocumentVersion.create(...a),
    },
    task: {
      upsert: (input: Parameters<typeof mockPrisma.task.upsert>[0]) =>
        mockPrisma.task.upsert(input),
      findUnique: () => mockPrisma.task.findUnique(),
    },
    codeSymbol: {
      count: (...a: unknown[]) => mockPrisma.codeSymbol.count(...a),
      groupBy: (...a: unknown[]) => mockPrisma.codeSymbol.groupBy(...a),
      findMany: (...a: unknown[]) => mockPrisma.codeSymbol.findMany(...a),
    },
    codeEdge: { findMany: (...a: unknown[]) => mockPrisma.codeEdge.findMany(...a) },
    codeGraph: {
      findFirst: (...a: unknown[]) => mockPrisma.codeGraph.findFirst(...a),
      findMany: (...a: unknown[]) => mockPrisma.codeGraph.findMany(...a),
    },
    finding: { findMany: (...a: unknown[]) => mockPrisma.finding.findMany(...a) },
    repoConnection: { findFirst: (...a: unknown[]) => mockPrisma.repoConnection.findFirst(...a) },
    docsGenFactCache: {
      findUnique: (...a: unknown[]) => mockPrisma.docsGenFactCache.findUnique(...a),
      upsert: (...a: unknown[]) => mockPrisma.docsGenFactCache.upsert(...a),
    },
    $transaction: (...a: unknown[]) => mockPrisma.$transaction(...a),
  },
}));

// ── provider mock ───────────────────────────────────────────────────────
// `streamScript` lets each test decide what every section stream emits (or
// throws). Phase-1 fact extraction also streams; we let it succeed trivially.
let sectionPrompts: string[] = [];
const providerBuild = vi.fn();
const searchBoundary = vi.fn();
vi.mock("../rag/knowledge-service.js", () => ({
  getKnowledgeService: () => ({ search: searchBoundary }),
}));
vi.mock("./rag-ingest.js", () => ({ ingestDocumentToRag: vi.fn() }));
vi.mock("../socket/job-events.js", () => ({
  jobEvents: {
    started: vi.fn(),
    progress: vi.fn(),
    completed: vi.fn(),
    failed: vi.fn(),
    docSection: vi.fn(),
  },
  genericFailureMessage: () => "Generation failed",
}));
let failOnSection: string | null = null;
/** #1360 — when set, the section stub appends this leaked source id to its prose. */
let leakSourceId: string | null = null;
// Captures every verification `provider.chat` call (extractor + judge) so tests
// can assert the extract→judge pass actually executed (#273).
let chatCalls: string[] = [];
// What the claim EXTRACTOR's `provider.chat` returns. Default: one claim.
// `sourceIds` are now OPTIONAL attribution only (not gated on). Tests override.
let claimChatResponse: { claims: { claim: string; sourceIds: string[] }[] } = {
  claims: [{ claim: "Grounded prose.", sourceIds: ["rag:doc1:c1"] }],
};
// #273 — what the faithfulness JUDGE returns. Default: every claim supported.
// Tests override (e.g. unsupported) to drive degraded scenarios. `null` here
// means "use the default supported-for-all verdict matching the extractor".
let judgeChatResponse: {
  verdicts: { claim: string; supported: boolean; sourceIds: string[] }[];
} | null = null;
// #283 — when set, computes the judge verdicts from the JUDGE PROMPT text. Lets a
// fixture assert a claim is entailed ONLY when a relevant source (e.g. a web
// digest) is present in the grounding shown to the judge.
let judgeVerdictFn:
  | ((judgePrompt: string) => { claim: string; supported: boolean; sourceIds: string[] }[])
  | null = null;
// When set, the claim-decomposition chat call throws (simulates an LLM error).
let claimChatThrows = false;

/** Is this `provider.chat` call the faithfulness judge (vs the extractor)? */
function isJudgePrompt(messages: { content?: unknown }[]): boolean {
  const user = String(messages[messages.length - 1]?.content ?? "");
  return user.includes("SOURCE EVIDENCE");
}

function makeProvider(): AIProvider {
  return {
    key: "bedrock-gateway",
    model: "mock",
    offline: false,
    chat: vi.fn(async (messages: { content?: unknown }[]) => {
      const user = String(messages[messages.length - 1]?.content ?? "");
      chatCalls.push(user);
      if (isJudgePrompt(messages)) {
        // Judge call. Build verdicts: content-aware fn override (#283), else the
        // explicit static override, else mark every extractor claim supported.
        const verdicts = judgeVerdictFn
          ? judgeVerdictFn(user)
          : (judgeChatResponse?.verdicts ??
            claimChatResponse.claims.map((c) => ({
              claim: c.claim,
              supported: true,
              sourceIds: c.sourceIds,
            })));
        return { content: JSON.stringify({ verdicts }) };
      }
      // Extractor call.
      if (claimChatThrows) throw new Error("synthetic claim-extraction failure");
      return { content: JSON.stringify(claimChatResponse) };
    }),
    embed: vi.fn(),
    models: vi.fn().mockResolvedValue(["mock"]),
    ping: vi.fn().mockResolvedValue(true),
    async *stream(messages, _opts): AsyncGenerator<ChatChunk> {
      const user = String(messages[messages.length - 1]?.content ?? "");
      // Phase-2 section calls carry the section-group banner; capture them.
      if (user.includes("section group now")) {
        sectionPrompts.push(user);
        if (failOnSection && user.includes(failOnSection)) {
          throw new Error("synthetic section failure");
        }
        // #1226 — each group must lead with its OWN H2. A stub that reused one
        // heading for every group had them collapsed into a single block by
        // `dedupeH2Sections`, which is now (correctly) reported as a missing
        // section rather than passing silently.
        const label = /Section group: \*\*(.+?)\*\*/.exec(user)?.[1] ?? "Section";
        const leak = leakSourceId ? ` ${leakSourceId}` : "";
        yield { type: "delta", content: `## ${label}\n\nGrounded prose.${leak}` };
        yield { type: "done" };
        return;
      }
      // Phase-1 fact extraction.
      yield { type: "delta", content: "PURPOSE\nmod." };
      yield { type: "done" };
    },
  } as unknown as AIProvider;
}

vi.mock("../ai/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ai/index.js")>();
  return {
    ...actual,
    buildProvider: () => {
      providerBuild();
      return makeProvider();
    },
    loadAIConfig: () => ({ provider: "bedrock-gateway", model: "mock" }),
  };
});

import {
  synthesizeHolisticDocument,
  buildSectionTopicQuery,
  resolvePhase2Router,
} from "./holistic-synthesizer.js";
import { buildGroundingContext as buildCtx } from "./grounding/grounding-context.js";
import type { SectionGroundingRetriever } from "./grounding/grounding-retrieval.js";
import { generateDocumentAsync } from "../../routes/generated-docs.js";
import { createEvidencePolicy, type EvidencePolicy } from "./evidence-policy.js";
import {
  GENERATED_DOC_PROVENANCE_SCHEMA_VERSION,
  generatedDocRevisionId,
  parseGeneratedDocVersionManifest,
} from "./generated-doc-provenance.js";
import { filterPrimaryEvidence } from "./evidence-filter.js";
import { jobEvents } from "../socket/job-events.js";

function seedHappyPrisma(): void {
  mockPrisma.project.findUnique.mockResolvedValue({ name: "Proj" });
  mockPrisma.codeSymbol.count.mockResolvedValue(10);
  mockPrisma.codeSymbol.groupBy.mockResolvedValue([{ filePath: "src/a.ts" }]);
  // One module with a class + enough methods to qualify.
  mockPrisma.codeSymbol.findMany.mockResolvedValue([
    {
      id: "s1",
      codeGraphId: "graph-a",
      graph: { repoConnectionId: "a" },
      contentHash: "h1",
      qualifiedName: "src.A",
      kind: "class",
      filePath: "src/a.ts",
      startLine: 1,
      endLine: 5,
    },
    {
      id: "s2",
      codeGraphId: "graph-a",
      graph: { repoConnectionId: "a" },
      contentHash: "h2",
      qualifiedName: "src.A.m1",
      kind: "method",
      filePath: "src/a.ts",
      startLine: 6,
      endLine: 9,
    },
    {
      id: "s3",
      codeGraphId: "graph-a",
      graph: { repoConnectionId: "a" },
      contentHash: "h3",
      qualifiedName: "src.A.m2",
      kind: "method",
      filePath: "src/a.ts",
      startLine: 10,
      endLine: 13,
    },
    {
      id: "s4",
      codeGraphId: "graph-a",
      graph: { repoConnectionId: "a" },
      contentHash: "h4",
      qualifiedName: "src.A.m3",
      kind: "method",
      filePath: "src/a.ts",
      startLine: 14,
      endLine: 17,
    },
  ]);
  mockPrisma.codeEdge.findMany.mockResolvedValue([]);
  mockPrisma.codeGraph.findFirst.mockResolvedValue(null);
  mockPrisma.codeGraph.findMany.mockResolvedValue([
    { id: "graph-a", repoConnection: { id: "a", projectId: "p1", deletedAt: null } },
  ]);
  mockPrisma.finding.findMany.mockResolvedValue([]);
  mockPrisma.repoConnection.findFirst.mockResolvedValue(null);
  mockPrisma.docsGenFactCache.findUnique.mockResolvedValue(null);
  mockPrisma.docsGenFactCache.upsert.mockResolvedValue({});
}

const grounding = buildGroundingContext({
  ragChunks: [
    { documentId: "doc1", chunkId: "c1", filename: "A.ts", text: "Grounding fact about A." },
  ],
});

describe("synthesizeHolisticDocument grounding + warnings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sectionPrompts = [];
    failOnSection = null;
    leakSourceId = null;
    chatCalls = [];
    claimChatThrows = false;
    claimChatResponse = {
      claims: [{ claim: "Grounded prose.", sourceIds: ["rag:doc1:c1"] }],
    };
    judgeChatResponse = null;
    judgeVerdictFn = null;
    // Force the online, non-gateway default-provider branch.
    delete process.env.BEDROCK_GATEWAY_URL;
    delete process.env.BEDROCK_GATEWAY_BASE_URL;
    process.env.AI_OFFLINE = "0";
    seedHappyPrisma();
  });

  afterEach(() => {
    process.env.AI_OFFLINE = "1";
  });

  it("#1353 missing repository graph fails before constructing any provider or querying project-wide symbols", async () => {
    await expect(
      synthesizeHolisticDocument("p1", "architecture", "Arch", { repoConnectorId: "missing" }),
    ).rejects.toMatchObject({ code: "REPOSITORY_GRAPH_UNAVAILABLE" });
    expect(providerBuild).not.toHaveBeenCalled();
    expect(mockPrisma.codeSymbol.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.codeSymbol.count).not.toHaveBeenCalled();
    expect(sectionPrompts).toEqual([]);
  });

  describe("#1353 real background → retrieval → SQL gate → synthesis → judge", () => {
    const doc = () => ({
      id: "self",
      projectId: "p1",
      title: "Arch",
      status: "pending",
      codeGraphHash: null as string | null,
      updatedAt: new Date("2026-09-18T00:00:00Z"),
      deletedAt: null,
      scope: "repository",
      scopeFilter: JSON.stringify({
        repoConnectorId: "a",
        actorId: "forged-admin",
        docType: "architecture",
      }),
      evidencePolicy: createEvidencePolicy(
        {
          userId: "alice",
          username: "alice",
          role: "coordinator",
          permissions: ["project.update"],
        },
        { sharedDocumentIds: ["reference"] },
      ),
    });
    let current: ReturnType<typeof doc>;
    const rows = () => [
      {
        id: "allowed",
        documentId: "allowed",
        text: "ALLOWED_REPO_A_EVIDENCE",
        filename: "connector:repo:a:src/same.ts",
        acl: "[]",
      },
      {
        id: "foreign",
        documentId: "foreign",
        text: "FORBIDDEN_REPO_B_EVIDENCE",
        filename: "connector:repo:b:src/same.ts",
        acl: "[]",
      },
      {
        id: "denied",
        documentId: "denied",
        text: "FORBIDDEN_ACL_EVIDENCE",
        filename: "connector:repo:a:src/denied.ts",
        acl: '[{"kind":"user","value":"bob"}]',
      },
      {
        id: "self",
        documentId: "gendoc-self",
        text: "FORBIDDEN_SELF_EVIDENCE",
        filename: "connector:repo:a:self.md",
        acl: "[]",
      },
      {
        id: "other",
        documentId: "gendoc-other",
        text: "FORBIDDEN_OTHER_GENERATED_EVIDENCE",
        filename: "connector:repo:a:other.md",
        acl: "[]",
      },
      {
        id: "reference",
        documentId: "reference",
        text: "ALLOWED_SHARED_REFERENCE",
        filename: "glossary.md",
        acl: "[]",
      },
    ];
    beforeEach(() => {
      current = doc();
      mockPrisma.generatedDocument.findFirst.mockImplementation(async () => ({ ...current }));
      mockPrisma.generatedDocument.update.mockResolvedValue({});
      mockPrisma.generatedDocument.updateMany.mockImplementation(
        async ({
          where,
          data,
        }: {
          where: Partial<typeof current>;
          data: Partial<typeof current>;
        }) => {
          if (
            where.id !== current.id ||
            where.projectId !== current.projectId ||
            (where.codeGraphHash !== undefined && where.codeGraphHash !== current.codeGraphHash) ||
            (where.updatedAt !== undefined && where.updatedAt !== current.updatedAt)
          )
            return { count: 0 };
          current = { ...current, ...data };
          return { count: 1 };
        },
      );
      mockPrisma.$transaction.mockImplementation(
        async (run: (tx: typeof mockPrisma) => Promise<void>) => run(mockPrisma),
      );
      mockPrisma.generatedDocumentVersion.findFirst.mockResolvedValue(null);
      mockPrisma.generatedDocumentVersion.create.mockResolvedValue({});
      mockPrisma.user.findFirst.mockResolvedValue({
        id: "alice",
        username: "alice",
        roles: [{ role: { key: "coordinator" } }],
        workspaceMemberships: [{ workspaceId: "w1" }],
      });
      mockPrisma.project.findFirst.mockResolvedValue({ id: "p1", name: "Proj", description: null });
      mockPrisma.project.findUnique.mockResolvedValue({ name: "Proj", workspaceId: "w1" });
      mockPrisma.codeGraph.findFirst.mockResolvedValue({ id: "graph-a" });
      mockPrisma.knowledgeChunk.findMany.mockImplementation(
        async ({ where }: { where: { id?: { in: string[] } } }) => {
          // Inventory returns the repository/shared candidate pool; the separate
          // SQL gate returns authoritative ACL/provenance rows, not pre-approved evidence.
          const candidates = rows().filter((r) =>
            where.id
              ? where.id.in.includes(r.id)
              : r.filename.startsWith("connector:repo:a:") || r.documentId === "reference",
          );
          return candidates.map((r) => ({
            id: r.id,
            documentId: r.documentId,
            text: r.text,
            position: 0,
            metadata: "{}",
            chunkerIdentity: null,
            aclSubjects: "[]",
            document: { filename: r.filename, storagePath: "blob", aclSubjects: r.acl },
          }));
        },
      );
      // Real filter below, not a hand-filtered list or mocked grounding context.
      // Separate KnowledgeService tests pin its placement before the reranker.
      searchBoundary.mockImplementation(
        async (_project: string, _query: string, opts: { evidencePolicy: EvidencePolicy }) => ({
          hits: await filterPrimaryEvidence(
            rows().map((r) => ({
              chunkId: r.id,
              documentId: r.documentId,
              filename: "STALE",
              text: "STALE_DENSE_TEXT",
            })),
            opts.evidencePolicy,
          ),
        }),
      );
    });

    it("only approved primary text reaches both synthesis and faithfulness-judge prompts", async () => {
      await generateDocumentAsync("self", "p1");
      expect(mockPrisma.generatedDocumentVersion.create).toHaveBeenCalled();
      expect(mockPrisma.$transaction).toHaveBeenCalledOnce();
      expect(mockPrisma.generatedDocument.updateMany).toHaveBeenCalledTimes(2);
      const claim = mockPrisma.generatedDocument.updateMany.mock.calls[0][0].data.codeGraphHash;
      expect(claim).toMatch(/^regenerating:/);
      expect(mockPrisma.generatedDocument.updateMany).toHaveBeenLastCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ codeGraphHash: claim }) }),
      );
      expect(jobEvents.failed).not.toHaveBeenCalled();
      expect(jobEvents.completed).toHaveBeenCalledOnce();
      expect(searchBoundary.mock.calls.length).toBeGreaterThan(1);
      for (const call of searchBoundary.mock.calls) {
        expect(call[2]).toMatchObject({
          actor: { userId: "alice", role: "coordinator" },
          evidencePolicy: {
            generatedDocumentId: "self",
            repoConnectorId: "a",
            codeGraphId: "graph-a",
          },
        });
      }
      const judgePrompts = chatCalls.filter((p) => p.includes("SOURCE EVIDENCE"));
      expect(sectionPrompts.length).toBeGreaterThan(0);
      expect(judgePrompts.length).toBeGreaterThan(0);
      for (const prompt of [...sectionPrompts, ...judgePrompts]) {
        expect(prompt).toContain("ALLOWED_REPO_A_EVIDENCE");
        expect(prompt).toContain("ALLOWED_SHARED_REFERENCE");
        expect(prompt).not.toContain("FORBIDDEN_");
        expect(prompt).not.toContain("STALE_DENSE_TEXT");
      }
      expect(mockPrisma.codeSymbol.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { projectId: "p1", codeGraphId: "graph-a" } }),
      );
    });

    it("persists an immutable version provenance manifest and revision identity (#1355)", async () => {
      await generateDocumentAsync("self", "p1");

      const createArg = mockPrisma.generatedDocumentVersion.create.mock.calls[0]?.[0] as {
        data: Record<string, unknown>;
      };
      expect(createArg.data.version).toBe(1);
      expect(createArg.data.revisionId).toBe(
        generatedDocRevisionId({
          projectId: "p1",
          generatedDocumentId: "self",
          version: 1,
        }),
      );

      const manifest = parseGeneratedDocVersionManifest(createArg.data.provenanceManifest);
      expect(manifest).toMatchObject({
        schemaVersion: GENERATED_DOC_PROVENANCE_SCHEMA_VERSION,
        revision: {
          revisionId: generatedDocRevisionId({
            projectId: "p1",
            generatedDocumentId: "self",
            version: 1,
          }),
          projectId: "p1",
          generatedDocumentId: "self",
          version: 1,
        },
        document: {
          scope: "repository",
          title: "Arch",
        },
        policy: {
          repoConnectorId: "a",
          codeGraphId: "graph-a",
          sharedDocumentIds: ["reference"],
          allowWebResearch: false,
        },
        generation: {
          pipeline: "holistic",
        },
        graphFingerprint: {
          algorithm: "sha256",
          fingerprint: expect.any(String),
        },
        historicalCitations: {
          status: "unavailable",
          mode: "stored-evidence-pending",
        },
        legacy: {
          historicalCitations: "pending",
        },
      });
      expect(manifest.generation.model.phase2.model).toBe(
        resolvePhase2Router(1).primary.tuning.phase2Model,
      );
      expect(manifest.graphFingerprint.fingerprint.length).toBeGreaterThan(0);
      expect(manifest.generation.prompts.phase1.version).toBeGreaterThan(0);
      expect(manifest.selectedEvidence.primary.some((row) => row.documentId === "reference")).toBe(
        true,
      );
      expect(
        manifest.selectedEvidence.primary.some((row) => row.repository?.repoConnectorId === "a"),
      ).toBe(true);
      expect(manifest.selectedEvidence.primary.every((row) => !("text" in row))).toBe(true);
      expect(manifest.sections.some((section) => section.groundingSourceIds.length > 0)).toBe(true);
      expect(
        manifest.sections.some((section) =>
          section.groundingSourceIds.some((sourceId) => sourceId === "rag:reference:reference"),
        ),
      ).toBe(true);
      expect(
        manifest.sections.some((section) => section.sectionSlug === "overview-context-layers"),
      ).toBe(true);
    });

    it.each([
      "missing-user",
      "revoked-role",
      "lost-membership",
      "legacy-policy",
      "missing-graph",
      "deleted-graph",
      "foreign-graph",
    ])("fails closed in background for %s before retrieval/providers", async (reason) => {
      if (reason === "missing-user") mockPrisma.user.findFirst.mockResolvedValue(null);
      if (reason === "revoked-role")
        mockPrisma.user.findFirst.mockResolvedValue({
          id: "alice",
          roles: [{ role: { key: "reader" } }],
          workspaceMemberships: [],
        });
      if (reason === "lost-membership")
        mockPrisma.project.findUnique.mockResolvedValue({ workspaceId: "foreign" });
      if (reason === "legacy-policy")
        current = {
          ...current,
          evidencePolicy: null,
        };
      if (reason.endsWith("graph")) mockPrisma.codeGraph.findFirst.mockResolvedValue(null);
      await generateDocumentAsync("self", "p1");
      expect(mockPrisma.generatedDocument.update).not.toHaveBeenCalled();
      expect(mockPrisma.generatedDocument.updateMany).toHaveBeenCalledExactlyOnceWith({
        where: {
          id: "self",
          projectId: "p1",
          deletedAt: null,
          status: "pending",
          updatedAt: new Date("2026-09-18T00:00:00.000Z"),
          codeGraphHash: null,
        },
        data: {
          status: "failed",
          errorMessage: "Generation failed",
        },
      });
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
      expect(jobEvents.started).not.toHaveBeenCalled();
      expect(jobEvents.completed).not.toHaveBeenCalled();
      expect(jobEvents.failed).toHaveBeenCalledExactlyOnceWith(
        "doc-generation",
        "self",
        "p1",
        "Generation failed",
      );
      expect(mockPrisma.generatedDocument.findFirst).toHaveBeenCalledTimes(1);
      expect(mockPrisma.knowledgeChunk.findMany).not.toHaveBeenCalled();
      expect(mockPrisma.codeSymbol.findMany).not.toHaveBeenCalled();
      expect(mockPrisma.codeEdge.findMany).not.toHaveBeenCalled();
      expect(searchBoundary).not.toHaveBeenCalled();
      expect(providerBuild).not.toHaveBeenCalled();
      expect(mockPrisma.generatedDocumentVersion.create).not.toHaveBeenCalled();
      expect(sectionPrompts).toEqual([]);
      expect(chatCalls).toEqual([]);
    });

    it("missing document is a no-op before authorization, claim, retrieval or providers", async () => {
      mockPrisma.generatedDocument.findFirst.mockResolvedValue(null);
      await generateDocumentAsync("self", "p1");
      expect(mockPrisma.user.findFirst).not.toHaveBeenCalled();
      expect(mockPrisma.generatedDocument.update).not.toHaveBeenCalled();
      expect(mockPrisma.generatedDocument.updateMany).not.toHaveBeenCalled();
      expect(mockPrisma.generatedDocumentVersion.create).not.toHaveBeenCalled();
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
      expect(mockPrisma.knowledgeChunk.findMany).not.toHaveBeenCalled();
      expect(searchBoundary).not.toHaveBeenCalled();
      expect(providerBuild).not.toHaveBeenCalled();
      expect(jobEvents.started).not.toHaveBeenCalled();
      expect(jobEvents.completed).not.toHaveBeenCalled();
      expect(jobEvents.failed).not.toHaveBeenCalled();
      expect(sectionPrompts).toEqual([]);
      expect(chatCalls).toEqual([]);
    });

    it("empty authorized evidence never falls back to unfiltered candidates", async () => {
      mockPrisma.knowledgeChunk.findMany.mockResolvedValue([]);
      await generateDocumentAsync("self", "p1");
      expect(mockPrisma.generatedDocumentVersion.create).toHaveBeenCalled();
      expect(sectionPrompts.length).toBeGreaterThan(0);
      for (const prompt of [...sectionPrompts, ...chatCalls]) {
        expect(prompt).not.toContain("FORBIDDEN_");
        expect(prompt).not.toContain("STALE_DENSE_TEXT");
        expect(prompt).not.toContain("ALLOWED_REPO_A_EVIDENCE");
      }
    });
  });

  it("injects the grounding block (source ids) into section prompts (#222)", async () => {
    const result = await synthesizeHolisticDocument("p1", "architecture", "Arch", { grounding });
    expect(result.warnings).toHaveLength(0);
    expect(sectionPrompts.length).toBeGreaterThan(0);
    expect(sectionPrompts.some((p) => p.includes("rag:doc1:c1"))).toBe(true);
    expect(sectionPrompts.some((p) => p.includes("RETRIEVED GROUNDING SOURCES"))).toBe(true);
  });

  it("returns no warnings and a clean markdown when all sections succeed", async () => {
    const result = await synthesizeHolisticDocument("p1", "architecture", "Arch", { grounding });
    expect(result.warnings).toHaveLength(0);
    expect(result.markdown).toContain("Grounded prose.");
    // No silent HTML-comment failure markers.
    expect(result.markdown).not.toContain("generation failed");
  });

  /**
   * #1360 — the stripper being correct in isolation proves nothing unless it is
   * actually WIRED into assembly. This drives a leaked id all the way through
   * synthesis and asserts the returned document is clean.
   */
  it("strips leaked grounding source ids from the assembled document (#1360)", async () => {
    leakSourceId = "[facts:repo:%5B%22conn-a%22%2C%22graph-a%22%2C%22src%22%5D:3]";
    const result = await synthesizeHolisticDocument("p1", "architecture", "Arch", { grounding });

    expect(result.markdown).not.toContain("[facts:");
    expect(result.markdown).not.toContain("%5B%22conn-a%22");
    // The prose itself survives — this strips ids, it does not delete content.
    expect(result.markdown).toContain("Grounded prose.");
  });

  it("strips the legacy module-scoped id shape too (#1360)", async () => {
    leakSourceId = "[facts:docker_oracle_init:1]";
    const result = await synthesizeHolisticDocument("p1", "architecture", "Arch", { grounding });
    expect(result.markdown).not.toContain("[facts:");
    expect(result.markdown).toContain("Grounded prose.");
  });

  it("surfaces a degraded-output warning when a section fails instead of an HTML comment (#225)", async () => {
    failOnSection = "Overview, Context"; // architecture's first section-group label
    const result = await synthesizeHolisticDocument("p1", "architecture", "Arch");
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0].kind).toBe("section-failed");
    expect(result.warnings[0].message).toContain("synthetic section failure");
    // The failed section is NOT buried as an HTML comment in the body.
    expect(result.markdown).not.toContain("<!-- Section");
  });

  it("works without a grounding context (ungrounded but still produces output)", async () => {
    const result = await synthesizeHolisticDocument("p1", "architecture", "Arch");
    expect(result.markdown).toContain("Grounded prose.");
    expect(sectionPrompts.some((p) => p.includes("RETRIEVED GROUNDING SOURCES"))).toBe(false);

    const manifest = parseGeneratedDocVersionManifest(result.provenanceManifest);
    expect(manifest.revision).toMatchObject({
      projectId: "p1",
      generatedDocumentId: "pending",
      version: 1,
      revisionId: generatedDocRevisionId({
        projectId: "p1",
        generatedDocumentId: "pending",
        version: 1,
      }),
    });
    expect(manifest.document).toMatchObject({
      title: "Arch",
      scope: "full",
      docType: "architecture",
    });
  });

  it("returns an empty-document result with no warnings when there are no modules", async () => {
    mockPrisma.codeSymbol.findMany.mockResolvedValue([]);
    const result = await synthesizeHolisticDocument("p1", "architecture", "Arch", { grounding });
    expect(result.warnings).toHaveLength(0);
    expect(result.markdown).toContain("No documentable modules");
  });

  // ── #273 — entailment-based faithfulness wired into the synthesis loop ──

  it("runs the claim extract→judge faithfulness pass on each grounded section (#273)", async () => {
    await synthesizeHolisticDocument("p1", "architecture", "Arch", { grounding });
    // At least one extractor + one judge chat call per generated section.
    expect(chatCalls.length).toBeGreaterThan(0);
    // The extractor prompt carries the section prose to decompose.
    expect(chatCalls.some((c) => c.includes("Grounded prose."))).toBe(true);
    // The judge prompt carries the source TEXT (not just ids) so it can verify.
    expect(chatCalls.some((c) => c.includes("SOURCE EVIDENCE"))).toBe(true);
    expect(chatCalls.some((c) => c.includes("Grounding fact about A."))).toBe(true);
  });

  it("POSITIVE: accurate synthesis (no exact id) stays ready — no false degraded (#273)", async () => {
    // The extractor emits an abstractive claim with NO sourceId (the SAS case),
    // and the judge finds it ENTAILED by the facts. Faithfulness 1.0 → ready.
    claimChatResponse = {
      claims: [{ claim: "The module enforces access policy.", sourceIds: [] }],
    };
    judgeChatResponse = {
      verdicts: [{ claim: "The module enforces access policy.", supported: true, sourceIds: [] }],
    };
    const result = await synthesizeHolisticDocument("p1", "architecture", "Arch", { grounding });
    expect(result.warnings.filter((w) => w.kind === "section-ungrounded")).toHaveLength(0);
    // Section prose is preserved intact (entailment never strips lines).
    expect(result.markdown).toContain("Grounded prose.");
  });

  it("NEGATIVE: hallucinated/unsupported claims drop faithfulness below threshold → degraded (#273)", async () => {
    // Three claims, only one supported → faithfulness 0.33 < 0.8 → degraded.
    claimChatResponse = {
      claims: [
        { claim: "The module enforces access policy.", sourceIds: [] },
        { claim: "The module mines cryptocurrency overnight.", sourceIds: [] },
        { claim: "Passwords are stored in plaintext.", sourceIds: [] },
      ],
    };
    judgeChatResponse = {
      verdicts: [
        { claim: "The module enforces access policy.", supported: true, sourceIds: [] },
        { claim: "The module mines cryptocurrency overnight.", supported: false, sourceIds: [] },
        { claim: "Passwords are stored in plaintext.", supported: false, sourceIds: [] },
      ],
    };
    const result = await synthesizeHolisticDocument("p1", "architecture", "Arch", { grounding });
    const ungrounded = result.warnings.filter((w) => w.kind === "section-ungrounded");
    expect(ungrounded.length).toBeGreaterThan(0);
    expect(ungrounded[0].severity).toBe("warning");
    // The numeric faithfulness ratio + threshold are persisted on the warning.
    expect(ungrounded[0].ratio).toBeCloseTo(1 / 3, 2);
    expect(ungrounded[0].threshold).toBeCloseTo(0.8, 5);
    // Entailment-based: the section prose is NOT mutated.
    expect(result.markdown).toContain("Grounded prose.");
  });

  it("stays ready when faithfulness is at/above threshold even with one unsupported claim (#273)", async () => {
    // 4 of 5 supported → 0.8 ≥ 0.8 threshold → NOT degraded (thresholded, not binary).
    const claims = ["a", "b", "c", "d", "e"].map((c) => ({ claim: c, sourceIds: [] }));
    claimChatResponse = { claims };
    judgeChatResponse = {
      verdicts: claims.map((c, i) => ({
        claim: c.claim,
        supported: i < 4,
        sourceIds: [],
      })),
    };
    const result = await synthesizeHolisticDocument("p1", "architecture", "Arch", { grounding });
    expect(result.warnings.filter((w) => w.kind === "section-ungrounded")).toHaveLength(0);
  });

  it("degrades a section to unverified (no crash, no false warning) when claim extraction throws", async () => {
    claimChatThrows = true;
    const result = await synthesizeHolisticDocument("p1", "architecture", "Arch", { grounding });
    // Synthesis still completes with the original prose...
    expect(result.markdown).toContain("Grounded prose.");
    // ...and we do NOT fabricate an unfaithful warning for content we could not verify.
    expect(result.warnings.filter((w) => w.kind === "section-ungrounded")).toHaveLength(0);
  });

  it("skips faithfulness verification entirely when there is no grounding context", async () => {
    await synthesizeHolisticDocument("p1", "architecture", "Arch");
    // No grounding → no extractor/judge calls at all.
    expect(chatCalls).toHaveLength(0);
  });

  it("emits no warning when decomposition yields zero claims (nothing to verify)", async () => {
    claimChatResponse = { claims: [] };
    const result = await synthesizeHolisticDocument("p1", "architecture", "Arch", { grounding });
    // Extractor ran but found nothing substantive → no warning, prose intact.
    expect(chatCalls.length).toBeGreaterThan(0);
    expect(result.warnings.filter((w) => w.kind === "section-ungrounded")).toHaveLength(0);
    expect(result.markdown).toContain("Grounded prose.");
  });

  // ── #243 — per-section live progress callback ───────────────────────────

  it("invokes onSectionProgress with generating→done transitions and section index/total (#243)", async () => {
    const updates: Array<{ section: string; status: string; index: number; total: number }> = [];
    await synthesizeHolisticDocument("p1", "architecture", "Arch", {
      grounding,
      onSectionProgress: (u) =>
        updates.push({ section: u.section, status: u.status, index: u.index, total: u.total }),
    });
    // Every section reports `generating` first, then a terminal state.
    expect(updates.some((u) => u.status === "generating")).toBe(true);
    expect(updates.some((u) => u.status === "done")).toBe(true);
    // Index is 1-based and total is stable across updates.
    const total = updates[0].total;
    expect(total).toBeGreaterThan(0);
    expect(updates.every((u) => u.index >= 1 && u.index <= total && u.total === total)).toBe(true);
  });

  it("reports a failed section with its warning via onSectionProgress (#243)", async () => {
    failOnSection = "Overview, Context"; // architecture's first section-group label
    const updates: Array<{ status: string; warning?: { kind: string } }> = [];
    await synthesizeHolisticDocument("p1", "architecture", "Arch", {
      onSectionProgress: (u) => updates.push({ status: u.status, warning: u.warning }),
    });
    const failed = updates.find((u) => u.status === "failed");
    expect(failed).toBeDefined();
    expect(failed?.warning?.kind).toBe("section-failed");
  });

  it("reports a degraded section when faithfulness is below threshold via onSectionProgress (#243)", async () => {
    claimChatResponse = { claims: [{ claim: "Grounded prose.", sourceIds: [] }] };
    judgeChatResponse = {
      verdicts: [{ claim: "Grounded prose.", supported: false, sourceIds: [] }],
    };
    const statuses: string[] = [];
    await synthesizeHolisticDocument("p1", "architecture", "Arch", {
      grounding,
      onSectionProgress: (u) => statuses.push(u.status),
    });
    expect(statuses).toContain("degraded");
  });

  it("never throws into synthesis when onSectionProgress throws (#243)", async () => {
    const result = await synthesizeHolisticDocument("p1", "architecture", "Arch", {
      grounding,
      onSectionProgress: () => {
        throw new Error("listener blew up");
      },
    });
    // Synthesis still produces a document despite the faulty listener.
    expect(result.markdown).toContain("Grounded prose.");
  });

  // ── #264 — per-section, query-targeted grounding retrieval ───────────────

  it("retrieves grounding per section using the section-topic query, not just the title (#264)", async () => {
    const seenQueries: string[] = [];
    const groundingForSection: SectionGroundingRetriever = async (req) => {
      seenQueries.push(req.query);
      return buildCtx({
        ragChunks: [{ documentId: "doc1", chunkId: "c1", filename: "A.ts", text: "fact" }],
      });
    };
    await synthesizeHolisticDocument("p1", "architecture", "Arch", { groundingForSection });
    expect(seenQueries.length).toBeGreaterThan(0);
    // Each query carries section-topic terms beyond the bare doc title.
    expect(seenQueries.some((q) => q !== "Arch")).toBe(true);
    expect(seenQueries.every((q) => q.includes("Arch"))).toBe(true);
  });

  it("judges each section against its OWN per-section source TEXT (#264 + #273)", async () => {
    // Each section's retriever returns a distinct source TEXT; the judge must be
    // shown THAT section's text — proving verification uses section sources.
    const groundingForSection: SectionGroundingRetriever = async (req) =>
      buildCtx({
        ragChunks: [
          { documentId: req.id, chunkId: "1", filename: "x.ts", text: `section-fact-${req.id}` },
        ],
      });
    claimChatResponse = { claims: [{ claim: "Grounded prose.", sourceIds: [] }] };
    const result = await synthesizeHolisticDocument("p1", "architecture", "Arch", {
      groundingForSection,
    });
    // Prose preserved (judge marks it supported by default).
    expect(result.markdown).toContain("Grounded prose.");
    // The judge prompt enumerated a per-section source text.
    expect(chatCalls.some((c) => c.includes("SOURCE EVIDENCE") && /section-fact-/.test(c))).toBe(
      true,
    );
  });

  it("falls back to the doc-level grounding when the per-section retriever returns undefined (#264 back-compat)", async () => {
    const groundingForSection: SectionGroundingRetriever = async () => undefined;
    const result = await synthesizeHolisticDocument("p1", "architecture", "Arch", {
      grounding,
      groundingForSection,
    });
    // Doc-level grounding block (with its source id) was injected.
    expect(sectionPrompts.some((p) => p.includes("rag:doc1:c1"))).toBe(true);
    expect(result.warnings.filter((w) => w.kind === "section-failed")).toHaveLength(0);
  });

  it("falls back to doc-level grounding when the per-section retriever throws (#264)", async () => {
    const groundingForSection: SectionGroundingRetriever = async () => {
      throw new Error("retrieval down");
    };
    const result = await synthesizeHolisticDocument("p1", "architecture", "Arch", {
      grounding,
      groundingForSection,
    });
    // Synthesis still completes and used the doc-level grounding block.
    expect(sectionPrompts.some((p) => p.includes("rag:doc1:c1"))).toBe(true);
    expect(result.markdown).toContain("Grounded prose.");
  });

  // ── #267 — synthesis facts admitted as citable grounding sources ─────────

  it("injects facts: sources into the section prompt AND lets a fact-supported claim stay ready (#267 + #273)", async () => {
    // Section retriever returns ONLY a tangential rag chunk (mirrors SAS: the
    // narrative facts are not in the raw chunk). The synthesized claim is judged
    // supported by the FACTS source for this module, which #267 admits.
    const groundingForSection: SectionGroundingRetriever = async () =>
      buildCtx({
        ragChunks: [{ documentId: "cfg", chunkId: "1", filename: "x.cfg", text: "noise" }],
      });
    // The module dir "src" is qualified by connector "a" and graph "graph-a".
    const factsId = "facts:repo:%5B%22a%22%2C%22graph-a%22%2C%22src%22%5D:0";
    claimChatResponse = {
      claims: [{ claim: "Grounded prose.", sourceIds: [] }],
    };
    const result = await synthesizeHolisticDocument("p1", "architecture", "Arch", {
      groundingForSection,
    });
    // The grounding block shown to the model enumerates a facts source id.
    expect(sectionPrompts.some((p) => p.includes("kind=facts"))).toBe(true);
    // The judge prompt is shown the facts source (text + id) so it can verify.
    expect(chatCalls.some((c) => c.includes("SOURCE EVIDENCE") && c.includes(factsId))).toBe(true);
    // The fact-supported claim stays ready → prose kept, no ungrounded warning.
    expect(result.markdown).toContain("Grounded prose.");
    expect(result.warnings.filter((w) => w.kind === "section-ungrounded")).toHaveLength(0);
  });

  it("does NOT merge facts (no grounding block, no validation) when grounding is opted out (#267 back-compat)", async () => {
    // No grounding context AND no per-section retriever → fully-ungrounded path.
    await synthesizeHolisticDocument("p1", "architecture", "Arch");
    expect(sectionPrompts.some((p) => p.includes("kind=facts"))).toBe(false);
    expect(sectionPrompts.some((p) => p.includes("RETRIEVED GROUNDING SOURCES"))).toBe(false);
    // No grounding → no claim-decomposition calls at all.
    expect(chatCalls).toHaveLength(0);
  });

  it("preserves degraded/ready semantics with a per-section retriever (#264 + #273)", async () => {
    // A per-section claim the judge finds UNSUPPORTED → faithfulness 0 < 0.8 →
    // section-ungrounded warning → doc degraded.
    const groundingForSection: SectionGroundingRetriever = async (req) =>
      buildCtx({
        ragChunks: [{ documentId: req.id, chunkId: "1", filename: "x.ts", text: "fact" }],
      });
    claimChatResponse = {
      claims: [{ claim: "Grounded prose.", sourceIds: [] }],
    };
    judgeChatResponse = {
      verdicts: [{ claim: "Grounded prose.", supported: false, sourceIds: [] }],
    };
    const result = await synthesizeHolisticDocument("p1", "architecture", "Arch", {
      groundingForSection,
    });
    expect(result.warnings.filter((w) => w.kind === "section-ungrounded").length).toBeGreaterThan(
      0,
    );
  });

  // ── #283 — per-section thresholds + honest narrative warning copy ────────

  it("frames each section tier honestly: narrative / reconstruction / literal (#283 + reconstruction tier)", async () => {
    // Every claim is judged UNSUPPORTED in every section → faithfulness 0,
    // below ALL three bars (narrative 0.4, reconstruction 0.6, literal 0.8). This
    // lets us assert the WARNING FRAMING differs per-section TIER at the same
    // ratio:
    //   - narrative (Overview & Domain, Core Business Capabilities): "domain
    //     context", gated at 0.4;
    //   - reconstruction (Key Workflows, Data & Domain Model): "inferred —
    //     verify", gated at 0.6;
    //   - literal (Business Rules, Calculations, Integrations & Glossary):
    //     "unreliable", gated at 0.8.
    const groundingForSection: SectionGroundingRetriever = async (req) =>
      buildCtx({
        ragChunks: [{ documentId: req.id, chunkId: "1", filename: "x.ts", text: "fact" }],
      });
    claimChatResponse = { claims: [{ claim: "Grounded prose.", sourceIds: [] }] };
    judgeChatResponse = {
      verdicts: [{ claim: "Grounded prose.", supported: false, sourceIds: [] }],
    };

    const result = await synthesizeHolisticDocument("p1", "business-requirements", "BR", {
      groundingForSection,
    });

    const ungrounded = result.warnings.filter((w) => w.kind === "section-ungrounded");
    const NARRATIVE = new Set(["Overview & Domain", "Core Business Capabilities"]);
    const RECONSTRUCTION = new Set(["Key Workflows", "Data & Domain Model"]);
    const narrative = ungrounded.filter((w) => NARRATIVE.has(w.section));
    const reconstruction = ungrounded.filter((w) => RECONSTRUCTION.has(w.section));
    const literal = ungrounded.filter(
      (w) => !NARRATIVE.has(w.section) && !RECONSTRUCTION.has(w.section),
    );

    // Narrative sections present, framed honestly (NOT "unreliable"), 0.4 bar.
    expect(narrative.length).toBeGreaterThan(0);
    for (const w of narrative) {
      expect(w.message).toContain("grounded in source code");
      expect(w.message).toContain("domain/business context from general knowledge");
      expect(w.message).not.toContain("unreliable");
      expect(w.threshold).toBeCloseTo(0.4, 5);
    }

    // Reconstruction sections framed as inferred-to-verify, gated at the 0.6 bar.
    expect(reconstruction.length).toBeGreaterThan(0);
    for (const w of reconstruction) {
      expect(w.message).toContain("inferred");
      expect(w.message).toContain("verify");
      expect(w.message).not.toContain("unreliable");
      expect(w.message).not.toContain("domain/business context from general knowledge");
      expect(w.threshold).toBeCloseTo(0.6, 5);
    }

    // Literal code-derived sections get the "review recommended" framing at the
    // strict 0.8 bar — calibrated to "not auto-verified against source", NOT the
    // old alarming "unreliable" (unverified ≠ wrong; often a retrieval gap).
    expect(literal.length).toBeGreaterThan(0);
    for (const w of literal) {
      expect(w.message.toLowerCase()).toContain("review");
      expect(w.message).toContain("verified against the retrieved source");
      expect(w.message).not.toContain("unreliable");
      expect(w.threshold).toBeCloseTo(0.8, 5);
    }
  });

  it("does NOT flag a narrative section whose faithfulness clears the lower 0.4 bar (#283)", async () => {
    // Two claims, one supported one not → faithfulness 0.5. That is ABOVE the
    // narrative bar (0.4) so Overview/Capabilities stay ready, but BELOW the 0.8
    // code bar so code-derived sections are still flagged. Proves the per-section
    // threshold genuinely changes the gate, not just the copy.
    const groundingForSection: SectionGroundingRetriever = async (req) =>
      buildCtx({
        ragChunks: [{ documentId: req.id, chunkId: "1", filename: "x.ts", text: "fact" }],
      });
    claimChatResponse = {
      claims: [
        { claim: "Claim A.", sourceIds: [] },
        { claim: "Claim B.", sourceIds: [] },
      ],
    };
    judgeChatResponse = {
      verdicts: [
        { claim: "Claim A.", supported: true, sourceIds: [] },
        { claim: "Claim B.", supported: false, sourceIds: [] },
      ],
    };

    const result = await synthesizeHolisticDocument("p1", "business-requirements", "BR", {
      groundingForSection,
    });

    const ungrounded = result.warnings.filter((w) => w.kind === "section-ungrounded");
    // Narrative sections clear 0.4 → NOT flagged.
    expect(
      ungrounded.some(
        (w) => w.section === "Overview & Domain" || w.section === "Core Business Capabilities",
      ),
    ).toBe(false);
    // A code-derived section (0.5 < 0.8) is still flagged.
    expect(
      ungrounded.some(
        (w) => w.section !== "Overview & Domain" && w.section !== "Core Business Capabilities",
      ),
    ).toBe(true);
  });

  it("a domain claim UNSUPPORTED by code chunks becomes ENTAILED when a relevant web digest is present (#283 part c)", async () => {
    // The synthesized Overview claim asserts a domain fact (Acme Freight network) that no
    // CODE chunk contains. The judge mock entails the claim ONLY when the grounding
    // shown to it contains the Acme Freight domain text — i.e. only when the web digest is
    // merged in. This is exactly the merge path domain-web-research feeds.
    claimChatResponse = {
      claims: [
        { claim: "The system operates within the Acme Freight freight network.", sourceIds: [] },
      ],
    };
    judgeVerdictFn = (judgePrompt) => [
      {
        claim: "The system operates within the Acme Freight freight network.",
        // Entailed only when the digest text reached the judge.
        supported: judgePrompt.includes("Acme Freight administers"),
        sourceIds: [],
      },
    ];

    // (1) WITHOUT a domain digest: Overview grounded only by a tangential code
    // chunk → the Acme Freight claim is unsupported → faithfulness 0 < 0.4 → flagged.
    const withoutDigest: SectionGroundingRetriever = async (req) =>
      buildCtx({
        ragChunks: [{ documentId: req.id, chunkId: "1", filename: "x.ts", text: "unrelated code" }],
      });
    const resA = await synthesizeHolisticDocument("p1", "business-requirements", "BR", {
      groundingForSection: withoutDigest,
    });
    expect(
      resA.warnings.some(
        (w) => w.section === "Overview & Domain" && w.kind === "section-ungrounded",
      ),
    ).toBe(true);

    // (2) WITH the domain digest merged into the grounding (as the doc retriever
    // does once domain web research has persisted it): the Acme Freight claim is now
    // entailed → Overview clears the bar → NO warning for it.
    const withDigest: SectionGroundingRetriever = async (req) =>
      buildCtx({
        ragChunks: [{ documentId: req.id, chunkId: "1", filename: "x.ts", text: "unrelated code" }],
        webDigests: [
          {
            id: "wd1",
            requirementId: "r",
            evidenceNeedId: "n",
            query: "Acme Freight network",
            sources: [
              {
                url: "https://www.acme-freight.example/markets",
                title: "Acme Freight Networks",
                excerpt: "Acme Freight administers the regional regional freight network.",
                relevanceScore: 0.9,
                domainTrust: "medium",
              },
            ],
            digest:
              "Acme Freight administers the regional regional freight network under DOT oversight.",
            needsHumanReview: false,
          },
        ],
      });
    const resB = await synthesizeHolisticDocument("p1", "business-requirements", "BR", {
      groundingForSection: withDigest,
    });
    expect(
      resB.warnings.some(
        (w) => w.section === "Overview & Domain" && w.kind === "section-ungrounded",
      ),
    ).toBe(false);
  });
});

describe("buildSectionTopicQuery (#264)", () => {
  it("combines the section label, topic keywords, and doc title", () => {
    const q = buildSectionTopicQuery({ id: "rules", label: "Business Rules & Policies" }, "My Doc");
    expect(q).toContain("Business Rules & Policies");
    expect(q).toContain("My Doc");
    // Includes at least one topic keyword for the rules section.
    expect(q.toLowerCase()).toContain("validation");
  });

  it("falls back to label + title when the section id has no keyword mapping", () => {
    const q = buildSectionTopicQuery({ id: "unknown-section", label: "Some Label" }, "Title");
    expect(q).toBe("Some Label Title");
  });
});
