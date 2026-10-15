/**
 * PR #1164 panel (#1135) — the production seeding wires the read-path pieces:
 * `defaultSeedChange` hands `resolveChangeSeeds` the lineage writer lookup, and
 * the seed loader selects each symbol's `signature`, which the handler boost
 * reads. Driven through an in-memory client that answers only the fields a
 * query SELECTS, so dropping either from production turns this red.
 */
import { describe, expect, it, vi } from "vitest";
import { defaultSeedChange } from "./impact-analysis-engine.js";
import type { ChangedRequirement } from "./extract-changes.js";

const HANDLER_SIG = "func (h *handler) showFeedEntriesPage(w http.ResponseWriter, r *http.Request)";

const SYMBOLS = [
  {
    id: "writer",
    name: "MarkFeedEntriesAsRead",
    kind: "function",
    language: "go",
    qualifiedName: "storage/entry.go::MarkFeedEntriesAsRead",
    filePath: "internal/storage/entry.go",
    startLine: 1,
    endLine: 9,
    projectId: "p1",
    signature: "func (s *Storage) MarkFeedEntriesAsRead(feedID int64) error",
    docComment: "MarkFeedEntriesAsRead marks the feed entries as read.",
    package: "storage",
  },
  {
    id: "handler",
    name: "showFeedEntriesPage",
    kind: "function",
    language: "go",
    qualifiedName: "ui/feed_entries.go::showFeedEntriesPage",
    filePath: "internal/ui/feed_entries.go",
    startLine: 1,
    endLine: 40,
    projectId: "p1",
    signature: HANDLER_SIG,
    docComment: "showFeedEntriesPage shows the feed entries page.",
    package: "ui",
  },
];

type Where = { projectId?: string; id?: { in: string[] } };
type Select = Record<string, boolean>;

/** A client that returns only what each query selects. */
function client() {
  const codeSymbol = {
    findMany: vi.fn(async ({ where, select }: { where: Where; select?: Select }) =>
      SYMBOLS.filter(
        (s) =>
          (!where.projectId || s.projectId === where.projectId) &&
          (!where.id || where.id.in.includes(s.id)),
      ).map((s) =>
        select ? Object.fromEntries(Object.entries(s).filter(([k]) => select[k])) : { ...s },
      ),
    ),
  };
  const codeEdge = {
    findMany: vi.fn(async ({ where }: { where: { fromSymbolId: { in: string[] } } }) =>
      where.fromSymbolId.in
        .filter((id) => id === "writer")
        .map((fromSymbolId) => ({ fromSymbolId })),
    ),
  };
  return { codeSymbol, codeEdge };
}

const noVectors = {
  vectorStore: { search: async () => [] },
  embedService: { embed: async () => ({ vectors: [], dimension: 0, model: "none" }) },
};

const title = "Feed entries page shows 0 entries after mark feed entries as read";
const body = "The feed entries page shows an empty page after marking the feed entries as read.";
const readPathBug: ChangedRequirement = {
  requirementId: null,
  title,
  body,
  changeType: "modified",
  bodyDelta: 1,
  request: {
    title,
    kind: "bug",
    primaryRequest: body,
    subAspects: [],
    context: [],
    ignored: [],
  },
};

describe("defaultSeedChange — read-path wiring (#1135, PR #1164 panel)", () => {
  it("looks up the table writers and keeps them out of the files to edit", async () => {
    const prisma = client();
    const seeds = await defaultSeedChange(prisma as never, noVectors as never)(readPathBug, "p1");
    expect(prisma.codeEdge.findMany).toHaveBeenCalled();
    const editFiles = seeds.editCandidates.map((m) => m.filePath);
    expect(editFiles).toContain("internal/ui/feed_entries.go");
    expect(editFiles).not.toContain("internal/storage/entry.go");
    expect(seeds.related.map((m) => m.codeSymbolId)).toContain("writer");
  });

  it("selects the signature the handler boost reads", async () => {
    const prisma = client();
    await defaultSeedChange(prisma as never, noVectors as never)(readPathBug, "p1");
    const seedLoads = prisma.codeSymbol.findMany.mock.calls.filter(([q]) => q.where.id);
    expect(seedLoads.length).toBeGreaterThan(0);
    for (const [q] of seedLoads) expect(q.select?.signature).toBe(true);
  });
});
