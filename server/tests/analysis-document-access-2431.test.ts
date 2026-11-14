/**
 * #2431 — an analysis's and a Spec Kit artifact's document reads and code
 * locators honour document access restrictions as a shared audience: their
 * output is read by every project member, so a restricted document never
 * reaches it, whoever started the run. Unit level: the retrieval functions,
 * the analysis `search_knowledge` tool, the capability count and the
 * affected-code seed. The orchestrator wiring is covered over a real database
 * in `analysis-document-access-2431.sqlite.test.ts`.
 */
import { describe, expect, it, vi } from "vitest";
import type { RetrievedChunk } from "@metis/shared";
import type { AclSubject } from "@metis/shared";
import {
  retrievePerRequirement,
  runGroundedRetrieval,
  UNRESTRICTED_RETRIEVAL,
} from "../src/lib/analysis/retrieval.js";
import { createSearchKnowledgeTool } from "../src/lib/analysis/tools/search-knowledge.js";
import {
  createCapabilityTracker,
  finalizeCapability,
  recordRestrictedLeftOut,
  restrictedLeftOutOf,
} from "../src/lib/analysis/analysis-capability.js";
import {
  computeAffectedCodeContext,
  EMPTY_AFFECTED_CODE_CONTEXT,
} from "../src/lib/analysis/affected-code-context.js";
import {
  codeAccessFilterOf,
  UNRESTRICTED_CODE_ACCESS,
} from "../src/lib/analysis/tools/code-access.js";
import { filterAccessible, isVisibleTo, type AclActor } from "../src/lib/rag/acl.js";
import { isSharedVisible, sharedDocumentAudience } from "../src/lib/analysis/document-access.js";
import type { KnowledgeService, SearchOptions } from "../src/lib/rag/knowledge-service.js";
import { InMemoryCodeGraphDataSource } from "../src/lib/impact-analysis/impact-analysis-engine.js";
import type { RequirementCodeMatch } from "../src/lib/traceability/requirement-code-mapping.js";

const ALICE = "u-alice";
const RESTRICTED: AclSubject[] = [{ kind: "user", value: ALICE }];

const hit = (chunkId: string, documentId: string, text: string): RetrievedChunk => ({
  chunkId,
  documentId,
  filename: `${documentId}.md`,
  position: Number(chunkId.replace(/\D/g, "")) || 0,
  text,
  score: 0.9,
  embeddingModel: "embed-a",
  source: "upload",
});

/**
 * A knowledge service that filters as `KnowledgeService.search` does: by the
 * actor when one is passed, reporting the denied ids when asked. One open
 * chunk and one chunk of a document restricted to Alice.
 */
function aclKnowledge() {
  const pool = [
    { ...hit("c-open-1", "d-open", "open requirement text"), aclSubjects: [] as AclSubject[] },
    { ...hit("c-secret-1", "d-secret", "SECRET requirement text"), aclSubjects: RESTRICTED },
  ];
  const calls: SearchOptions[] = [];
  const search = vi.fn(async (_projectId: string, _query: string, opts: SearchOptions = {}) => {
    calls.push(opts);
    let chosen = pool.filter((c) => !opts.documentIds || opts.documentIds.includes(c.documentId));
    let aclMismatch: string[] | undefined;
    if (opts.actor) {
      const { allowed, deniedChunkIds } = filterAccessible(chosen, opts.actor);
      chosen = allowed;
      if (opts.reportAclMismatch && deniedChunkIds.length > 0) aclMismatch = deniedChunkIds;
    }
    return {
      hits: chosen.map(({ aclSubjects: _acl, ...h }) => h),
      mode: "hybrid" as const,
      ...(aclMismatch ? { aclMismatch } : {}),
    };
  });
  return { knowledge: { search } as unknown as KnowledgeService, calls };
}

describe("#2431 — the shared document audience", () => {
  it("is the system actor reading as a shared audience: it sees no restricted document", () => {
    const actor = sharedDocumentAudience();
    expect(actor).toEqual({ userId: "system", role: "shared-audience", sharedAudience: true });
    expect(isVisibleTo({ subjects: RESTRICTED }, actor)).toBe(false);
    expect(isVisibleTo({ subjects: [{ kind: "role", value: "admin" }] }, actor)).toBe(false);
    expect(isVisibleTo({ subjects: [] }, actor)).toBe(true);
  });

  it("names the requester on its audit rows, and still reads only what every member may", () => {
    const actor = sharedDocumentAudience(ALICE);
    expect(actor).toEqual({ userId: ALICE, role: "shared-audience", sharedAudience: true });
    // Restricted to Alice herself: attributing the read to her grants nothing.
    expect(isVisibleTo({ subjects: RESTRICTED }, actor)).toBe(false);
    expect(isVisibleTo({ subjects: [] }, actor)).toBe(true);
    // No requester (a scheduled run, an eval): the system actor.
    expect(sharedDocumentAudience(null).userId).toBe("system");
    expect(sharedDocumentAudience("").userId).toBe("system");
  });

  it("returns a fresh actor each call", () => {
    const a = sharedDocumentAudience();
    (a as AclActor).role = "admin";
    expect(sharedDocumentAudience().role).toBe("shared-audience");
  });

  it("reads a stored ACL: empty or unreadable is visible, any subject is not", () => {
    expect(isSharedVisible("[]")).toBe(true);
    expect(isSharedVisible(null)).toBe(true);
    expect(isSharedVisible(JSON.stringify(RESTRICTED))).toBe(false);
    expect(isSharedVisible(JSON.stringify([{ kind: "role", value: "developer" }]))).toBe(false);
  });
});

describe("#2431 — runGroundedRetrieval under a document ACL", () => {
  it("searches as the actor given and reports the chunks each search dropped", async () => {
    const { knowledge, calls } = aclKnowledge();
    const denied: string[][] = [];
    const out = await runGroundedRetrieval(knowledge, {
      projectId: "p1",
      queries: ["requirements", "scope"],
      actor: sharedDocumentAudience(),
      onAclDenied: (ids) => denied.push(ids),
      rerank: false,
    });
    expect(out.map((c) => c.documentId)).toEqual(["d-open"]);
    expect(out.map((c) => c.text).join("\n")).not.toContain("SECRET");
    expect(calls).toHaveLength(2);
    for (const opts of calls) {
      expect(opts.actor).toEqual(sharedDocumentAudience());
      expect(opts.reportAclMismatch).toBe(true);
    }
    expect(denied).toEqual([["c-secret-1"], ["c-secret-1"]]);
  });

  it("applies no ACL and asks for no report only when told by name (an eval over fixed documents)", async () => {
    const { knowledge, calls } = aclKnowledge();
    const onAclDenied = vi.fn();
    const out = await runGroundedRetrieval(knowledge, {
      projectId: "p1",
      queries: ["requirements"],
      actor: UNRESTRICTED_RETRIEVAL,
      onAclDenied,
      rerank: false,
    });
    expect(out.map((c) => c.documentId).sort()).toEqual(["d-open", "d-secret"]);
    expect(calls[0]).not.toHaveProperty("actor");
    expect(calls[0]).not.toHaveProperty("reportAclMismatch");
    expect(onAclDenied).not.toHaveBeenCalled();
  });

  it("does not report a search that dropped nothing", async () => {
    const { knowledge } = aclKnowledge();
    const onAclDenied = vi.fn();
    await runGroundedRetrieval(knowledge, {
      projectId: "p1",
      queries: ["requirements"],
      documentIds: ["d-open"],
      actor: sharedDocumentAudience(),
      onAclDenied,
      rerank: false,
    });
    expect(onAclDenied).not.toHaveBeenCalled();
  });
});

describe("#2431 — retrievePerRequirement under a document ACL", () => {
  it("searches each requirement as the actor and reports what each dropped", async () => {
    const { knowledge, calls } = aclKnowledge();
    const denied: string[][] = [];
    const evidence = await retrievePerRequirement(knowledge, {
      projectId: "p1",
      requirements: [
        { id: "R1", text: "first" },
        { id: "R2", text: "second" },
      ],
      actor: sharedDocumentAudience(),
      onAclDenied: (ids) => denied.push(ids),
      concurrency: 1,
    });
    expect(evidence.flatMap((e) => e.chunks.map((c) => c.documentId))).toEqual([
      "d-open",
      "d-open",
    ]);
    expect(JSON.stringify(evidence)).not.toContain("SECRET");
    expect(calls.every((c) => c.actor?.sharedAudience === true && c.reportAclMismatch)).toBe(true);
    expect(denied).toEqual([["c-secret-1"], ["c-secret-1"]]);
  });
});

describe("#2431 — the analysis search_knowledge tool", () => {
  it("always searches as a shared audience and reports what it dropped", async () => {
    const { knowledge, calls } = aclKnowledge();
    const onAclDenied = vi.fn();
    const tool = createSearchKnowledgeTool({ knowledgeService: knowledge, onAclDenied });
    const res = await tool.execute({ query: "requirements" }, { projectId: "p1" });
    expect(res.content).toContain("open requirement text");
    expect(res.content).not.toContain("SECRET");
    expect(res.resultCount).toBe(1);
    expect(calls[0]).toMatchObject({ actor: sharedDocumentAudience(), reportAclMismatch: true });
    expect(onAclDenied).toHaveBeenCalledWith(["c-secret-1"]);
  });

  it("names the run's requester on the search, granting nothing", async () => {
    const { knowledge, calls } = aclKnowledge();
    const tool = createSearchKnowledgeTool({ knowledgeService: knowledge, triggeredBy: ALICE });
    const res = await tool.execute({ query: "requirements" }, { projectId: "p1" });
    // The chunk restricted to Alice is still left out of a search made for her run.
    expect(res.content).not.toContain("SECRET");
    expect(calls[0]?.actor).toEqual({
      userId: ALICE,
      role: "shared-audience",
      sharedAudience: true,
    });
  });

  it("works without a counter, and reports nothing when nothing was dropped", async () => {
    const search = vi.fn(async () => ({ hits: [hit("c1", "d-open", "open")], mode: "hybrid" }));
    const tool = createSearchKnowledgeTool({
      knowledgeService: { search } as unknown as KnowledgeService,
    });
    const res = await tool.execute({ query: "q" }, { projectId: "p1" });
    expect(res.resultCount).toBe(1);
  });
});

describe("#2431 — the run's count of document chunks left out", () => {
  const tracker = () =>
    createCapabilityTracker({
      static: {
        codeGraphPresent: true,
        repoSourceIngested: true,
        fusedCodeRetrievalEnabled: true,
        schemaContextEnabled: true,
      },
      codeAnalysisRequested: true,
      databaseAnalysisRequested: false,
    });

  it("counts distinct chunks across searches, beside the code counts", () => {
    const t = tracker();
    recordRestrictedLeftOut(t, { documentChunkIds: ["c1", "c2"] });
    recordRestrictedLeftOut(t, { documentChunkIds: ["c2", "c3"] });
    recordRestrictedLeftOut(t, { files: 2, symbolIds: ["s1"] });
    expect(restrictedLeftOutOf(t)).toEqual({
      reason: "shared-audience",
      files: 2,
      symbols: 1,
      documentChunks: 3,
    });
    expect(finalizeCapability(t).restrictedLeftOut).toEqual({
      reason: "shared-audience",
      files: 2,
      symbols: 1,
      documentChunks: 3,
    });
  });

  it("records documents alone, and a document report leaves the code file count untouched", () => {
    const t = tracker();
    recordRestrictedLeftOut(t, { files: 4 });
    recordRestrictedLeftOut(t, { documentChunkIds: ["c1"] });
    expect(restrictedLeftOutOf(t)).toEqual({
      reason: "shared-audience",
      files: 4,
      symbols: 0,
      documentChunks: 1,
    });
    const docsOnly = tracker();
    recordRestrictedLeftOut(docsOnly, { documentChunkIds: ["c1"] });
    expect(restrictedLeftOutOf(docsOnly)).toEqual({
      reason: "shared-audience",
      files: 0,
      symbols: 0,
      documentChunks: 1,
    });
  });

  it("writes no documentChunks when none was dropped, and nothing at all when nothing was", () => {
    const t = tracker();
    recordRestrictedLeftOut(t, { documentChunkIds: [] });
    expect(restrictedLeftOutOf(t)).toBeNull();
    recordRestrictedLeftOut(t, { files: 1 });
    expect(restrictedLeftOutOf(t)).toEqual({ reason: "shared-audience", files: 1, symbols: 0 });
  });
});

describe("#2431 — the affected-code seed names no restricted file", () => {
  const SECRET = "server/src/billing/secret.ts";
  const OPEN = "server/src/billing/invoice.ts";
  const matches: RequirementCodeMatch[] = [
    {
      codeSymbolId: "s-secret",
      filePath: SECRET,
      qualifiedName: "SecretPricing.rate",
      startLine: 3,
      endLine: 9,
      confidence: 0.95,
    },
    {
      codeSymbolId: "s-open",
      filePath: OPEN,
      qualifiedName: "InvoiceService.charge",
      startLine: 20,
      endLine: 40,
      confidence: 0.9,
    },
  ];
  const deps = {
    mapRequirement: async () => matches,
    dataSourceFor: () => new InMemoryCodeGraphDataSource([], []),
  };
  const compute = (codeAccess?: () => Promise<typeof UNRESTRICTED_CODE_ACCESS>) =>
    computeAffectedCodeContext({
      projectId: "p1",
      extraInstructions: "Add a monthly invoice charge.",
      enabled: true,
      tokenBudget: 100000,
      deps,
      ...(codeAccess ? { codeAccess } : {}),
    });

  it("leaves a hidden file's symbol out of the seeds, the persisted links and the cited files", async () => {
    const ctx = await compute(async () =>
      codeAccessFilterOf([{ connectorId: "rc-1", path: SECRET }]),
    );
    const everything = JSON.stringify(ctx);
    expect(everything).not.toContain("secret.ts");
    expect(everything).not.toContain("SecretPricing");
    expect(ctx.filePaths).toEqual([OPEN]);
    expect(ctx.block).toContain("InvoiceService.charge");
    expect(ctx.result.candidates[0]!.symbols.map((s) => s.qualifiedName)).toEqual([
      "InvoiceService.charge",
    ]);
  });

  it("keeps it when nothing is hidden, and with no filter (an eval harness)", async () => {
    for (const ctx of [await compute(async () => UNRESTRICTED_CODE_ACCESS), await compute()]) {
      expect(ctx.filePaths.sort()).toEqual([OPEN, SECRET].sort());
    }
  });

  it("maps nothing when the filter cannot be read", async () => {
    const ctx = await compute(async () => {
      throw new Error("db down");
    });
    expect(ctx).toEqual(EMPTY_AFFECTED_CODE_CONTEXT);
  });

  it("does not load the filter when there is nothing to map", async () => {
    const load = vi.fn(async () => UNRESTRICTED_CODE_ACCESS);
    const ctx = await computeAffectedCodeContext({
      projectId: "p1",
      extraInstructions: "   ",
      enabled: true,
      deps,
      codeAccess: load,
    });
    expect(ctx).toEqual(EMPTY_AFFECTED_CODE_CONTEXT);
    expect(load).not.toHaveBeenCalled();
  });
});
