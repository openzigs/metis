import { describe, expect, it, vi } from "vitest";
import {
  buildProjectGroundingContext,
  buildSectionGroundingRetriever,
  type KnowledgeSearchLike,
} from "./grounding-retrieval.js";
import type { EvidencePolicy } from "../evidence-policy.js";

const policy: EvidencePolicy = {
  projectId: "p1",
  generatedDocumentId: "gen1",
  actor: { userId: "alice", role: "developer" },
  sharedDocumentIds: [],
  allowWebResearch: false,
};

const hits = [
  { documentId: "d1", chunkId: "c1", filename: "connector:repo:r1:src/packages/fit/src/a.ts" },
  { documentId: "d2", chunkId: "c2", filename: "connector:repo:r1:src/apps/web/src/b.ts" },
  { documentId: "d3", chunkId: "c3", filename: "connector:repo:r1:src/packages/fitness/c.ts" },
  { documentId: "d4", chunkId: "c4", filename: "requirements-brief.pdf" },
].map((h) => ({ ...h, source: h.filename.startsWith("connector:") ? "repo" : "upload" }));

// #547 — an upload stored before #540 under a connector-shaped name is a
// reference document: a path scope never drops it.
const legacyUpload = {
  documentId: "d5",
  chunkId: "c5",
  filename: "connector:repo:r1:src/apps/web/src/legacy.ts",
  source: "upload",
};

const knowledge = (extra: Array<typeof legacyUpload> = []): KnowledgeSearchLike => ({
  search: vi
    .fn()
    .mockResolvedValue({ hits: [...hits, ...extra].map((h) => ({ ...h, text: "chunk" })) }),
});

describe("grounding retrieval — path scope", () => {
  it("unscoped: every hit is kept", async () => {
    const ctx = await buildProjectGroundingContext(
      { projectId: "p1", policy, query: "rules" },
      { knowledge: knowledge() },
    );
    expect(ctx.sources.map((s) => s.documentId)).toEqual(["d1", "d2", "d3", "d4"]);
  });

  it("drops repository-source chunks outside the scope, keeps reference documents", async () => {
    const ctx = await buildProjectGroundingContext(
      { projectId: "p1", policy, query: "rules", pathPrefixes: ["packages/fit"] },
      { knowledge: knowledge() },
    );
    expect(ctx.sources.map((s) => s.documentId)).toEqual(["d1", "d4"]);
  });

  it("keeps a connector-shaped upload: its source says it is a reference", async () => {
    const ctx = await buildProjectGroundingContext(
      { projectId: "p1", policy, query: "rules", pathPrefixes: ["packages/fit"] },
      { knowledge: knowledge([legacyUpload]) },
    );
    expect(ctx.sources.map((s) => s.documentId)).toEqual(["d1", "d4", "d5"]);
  });

  it("applies the same scope per section", async () => {
    const retrieve = buildSectionGroundingRetriever(
      { projectId: "p1", policy, pathPrefixes: ["packages/fit"] },
      { knowledge: knowledge() },
    );
    const ctx = await retrieve({ id: "rules", query: "rules" });
    expect(ctx?.sources.map((s) => s.documentId)).toEqual(["d1", "d4"]);
  });
});
