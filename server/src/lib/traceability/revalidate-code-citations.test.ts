/**
 * #1831 — the re-validation rules, one link at a time, against an in-memory
 * graph. The end-to-end path (real ingest, real SQLite, the route) is
 * `tests/citation-revalidation-1831.sqlite.test.ts`; this covers the rules that
 * fixture does not reach and the hook's never-throw contract.
 */
import { describe, expect, it } from "vitest";
import {
  revalidateCodeCitations,
  revalidateCodeCitationsAfterIngest,
  type RevalidatePrisma,
} from "./revalidate-code-citations.js";

interface Sym {
  id: string;
  name: string;
  kind: string;
  qualifiedName: string;
  filePath: string;
  startLine: number;
  endLine: number;
  contentHash: string;
}
interface Link {
  id: string;
  source: string;
  codeSymbolId: string | null;
  filePath: string;
  startLine: number | null;
  endLine: number | null;
  symbolQualifiedName: string | null;
  symbolKind: string | null;
  symbolContentHash: string | null;
  codeSymbol:
    (Pick<Sym, "qualifiedName" | "kind" | "contentHash"> & { codeGraphId: string }) | null;
}

const fn = (name: string, filePath: string, startLine: number, hash: string): Sym => ({
  id: `${filePath}#${name}@${startLine}`,
  name,
  kind: "function",
  qualifiedName: `${filePath}::${name}`,
  filePath,
  startLine,
  endLine: startLine + 4,
  contentHash: hash,
});
const mod = (filePath: string, lines: number): Sym => ({
  id: `${filePath}#module`,
  name: filePath.split("/").pop()!,
  kind: "module",
  qualifiedName: filePath,
  filePath,
  startLine: 1,
  endLine: lines,
  contentHash: `m-${filePath}`,
});
/** A link written by the #1831 seeder: it holds its symbol's identity. */
const citing = (id: string, s: Sym, extra: Partial<Link> = {}): Link => ({
  id,
  source: "analysis-grounding",
  codeSymbolId: null,
  filePath: s.filePath,
  startLine: s.startLine,
  endLine: s.endLine,
  symbolQualifiedName: s.qualifiedName,
  symbolKind: s.kind,
  symbolContentHash: s.contentHash,
  codeSymbol: null,
  ...extra,
});

function fakePrisma(opts: { graph?: boolean; symbols: Sym[]; links: Link[] }) {
  const updates: Array<{ ids: string[]; data: Record<string, unknown> }> = [];
  const prisma = {
    codeGraph: {
      findUnique: async () =>
        opts.graph === false ? null : { id: "g", projectId: "p", commitSha: "sha" },
      count: async () => 1,
    },
    requirementCodeMapping: {
      findMany: async () => opts.links,
      updateMany: async ({ where, data }: { where: { id: { in: string[] } }; data: never }) => {
        updates.push({ ids: where.id.in, data });
        return { count: where.id.in.length };
      },
    },
    codeSymbol: {
      findMany: async ({ where }: { where: { name: { in: string[] }; kind: { in: string[] } } }) =>
        opts.symbols.filter(
          (s) => where.name.in.includes(s.name) && where.kind.in.includes(s.kind),
        ),
      groupBy: async ({ where }: { where: { filePath: { in: string[] } } }) => {
        const out = new Map<string, number>();
        for (const s of opts.symbols) {
          if (!where.filePath.in.includes(s.filePath)) continue;
          out.set(s.filePath, Math.max(out.get(s.filePath) ?? 0, s.endLine));
        }
        return [...out].map(([filePath, endLine]) => ({ filePath, _max: { endLine } }));
      },
    },
  } as unknown as RevalidatePrisma;
  /** The update written for one link. */
  const of = (id: string) => updates.find((u) => u.ids.includes(id))?.data;
  return { prisma, updates, of };
}

const NOW = new Date("2026-11-05T12:00:00Z");

describe("revalidateCodeCitations (#1831)", () => {
  it("does nothing for a graph that is gone, or a repo with no links", async () => {
    const gone = fakePrisma({ graph: false, symbols: [], links: [] });
    expect(await revalidateCodeCitations(gone.prisma, "g", NOW)).toMatchObject({ checked: 0 });
    const empty = fakePrisma({ symbols: [], links: [] });
    expect(await revalidateCodeCitations(empty.prisma, "g", NOW)).toMatchObject({ checked: 0 });
    expect(empty.updates).toEqual([]);
  });

  it("stamps the graph, its commit and the time on every link it checks", async () => {
    const s = fn("a", "src/a.ts", 1, "h");
    const { prisma, of } = fakePrisma({
      symbols: [s],
      links: [citing("l1", s, { codeSymbolId: s.id }), citing("nulled", s)],
    });
    await revalidateCodeCitations(prisma, "g", NOW);
    expect(of("l1")).toEqual({
      codeGraphId: "g",
      commitSha: "sha",
      validatedAt: NOW,
      freshness: "fresh",
      staleReason: null,
    });
    // An ingest that rewrote the file nulled the link's symbol: it is re-pointed.
    expect(of("nulled")).toMatchObject({ freshness: "fresh", codeSymbolId: s.id });
  });

  it("a single symbol elsewhere with a different hash is stale, content-changed, not moved", async () => {
    const old = fn("a", "src/a.ts", 1, "h1");
    const { prisma, of } = fakePrisma({
      symbols: [mod("src/a.ts", 3), fn("a", "src/b.ts", 1, "h2")],
      links: [citing("l1", old)],
    });
    await revalidateCodeCitations(prisma, "g", NOW);
    expect(of("l1")).toMatchObject({ freshness: "stale", staleReason: "content-changed" });
    expect(of("l1")).not.toHaveProperty("filePath");
  });

  it("no candidate while the file remains is stale, symbol-missing", async () => {
    const old = fn("gone", "src/a.ts", 1, "h");
    const { prisma, of } = fakePrisma({
      symbols: [mod("src/a.ts", 9)],
      links: [citing("l1", old)],
    });
    await revalidateCodeCitations(prisma, "g", NOW);
    expect(of("l1")).toMatchObject({ freshness: "stale", staleReason: "symbol-missing" });
  });

  it("two candidates in the cited file are stale, never a guess", async () => {
    const old = fn("a", "src/a.ts", 1, "h");
    const { prisma, of } = fakePrisma({
      symbols: [fn("a", "src/a.ts", 1, "h"), fn("a", "src/a.ts", 20, "h")],
      links: [citing("l1", old)],
    });
    await revalidateCodeCitations(prisma, "g", NOW);
    expect(of("l1")).toMatchObject({ freshness: "stale", staleReason: "symbol-missing" });
  });

  it("a file-level link past the end of a file that shrank is stale, content-changed", async () => {
    const { prisma, of } = fakePrisma({
      symbols: [mod("src/a.ts", 10), mod("src/b.ts", 50)],
      links: [
        citing("short", mod("src/a.ts", 40), { symbolQualifiedName: null }),
        citing("long", mod("src/b.ts", 40), { symbolQualifiedName: null }),
        citing("whole", mod("src/b.ts", 50), { startLine: null, endLine: null }),
      ],
    });
    await revalidateCodeCitations(prisma, "g", NOW);
    expect(of("short")).toMatchObject({ freshness: "stale", staleReason: "content-changed" });
    expect(of("long")).toMatchObject({ freshness: "fresh" });
    // A module-bound link (its qualified name is the path) is a file-level link.
    expect(of("whole")).toMatchObject({ freshness: "fresh" });
  });

  it("a schema-style name with no file root is checked as a file-level link", async () => {
    const { prisma, of } = fakePrisma({
      symbols: [mod("db/schema.sql", 30)],
      links: [
        citing("t", mod("db/schema.sql", 30), {
          symbolQualifiedName: "public.orders",
          symbolKind: "table",
          startLine: 3,
          endLine: 9,
        }),
      ],
    });
    await revalidateCodeCitations(prisma, "g", NOW);
    expect(of("t")).toMatchObject({ freshness: "fresh" });
  });

  it("falls back to the live symbol row for a link written before #1831, and stores its identity", async () => {
    const s = fn("a", "src/a.ts", 1, "h");
    const { prisma, of } = fakePrisma({
      symbols: [s],
      links: [
        citing("l1", s, {
          codeSymbolId: s.id,
          symbolQualifiedName: null,
          symbolKind: null,
          symbolContentHash: null,
          codeSymbol: {
            codeGraphId: "g",
            qualifiedName: s.qualifiedName,
            kind: "function",
            contentHash: "h",
          },
        }),
        // A live symbol in ANOTHER graph is not this repo's evidence: file-level.
        citing("l2", s, {
          codeSymbolId: "elsewhere",
          symbolQualifiedName: null,
          codeSymbol: {
            codeGraphId: "other",
            qualifiedName: s.qualifiedName,
            kind: "function",
            contentHash: "x",
          },
        }),
      ],
    });
    await revalidateCodeCitations(prisma, "g", NOW);
    expect(of("l1")).toMatchObject({
      freshness: "fresh",
      symbolQualifiedName: "src/a.ts::a",
      symbolKind: "function",
      symbolContentHash: "h",
    });
    expect(of("l2")).toMatchObject({ freshness: "fresh" });
    expect(of("l2")).not.toHaveProperty("symbolQualifiedName");
  });

  it("leaves a manual link's lines alone when its symbol drifted, but keeps it fresh", async () => {
    const old = fn("a", "src/a.ts", 1, "h");
    const { prisma, of } = fakePrisma({
      symbols: [fn("a", "src/a.ts", 30, "h")],
      links: [citing("m", old, { source: "manual", codeSymbolId: old.id })],
    });
    await revalidateCodeCitations(prisma, "g", NOW);
    expect(of("m")).toEqual({
      codeGraphId: "g",
      commitSha: "sha",
      validatedAt: NOW,
      freshness: "fresh",
      staleReason: null,
    });
  });

  it("a manual link whose file is gone and symbol moved is stale, file-missing", async () => {
    const old = fn("a", "src/a.ts", 1, "h");
    const { prisma, of } = fakePrisma({
      symbols: [fn("a", "src/b.ts", 1, "h")],
      links: [citing("m", old, { source: "manual" })],
    });
    await revalidateCodeCitations(prisma, "g", NOW);
    expect(of("m")).toMatchObject({ freshness: "stale", staleReason: "file-missing" });
  });

  it("groups links with the same outcome into one write, chunked by 500", async () => {
    const s = fn("a", "src/a.ts", 1, "h");
    const links = Array.from({ length: 1200 }, (_, i) => citing(`l${i}`, s));
    const { prisma, updates } = fakePrisma({ symbols: [s], links });
    const summary = await revalidateCodeCitations(prisma, "g", NOW);
    expect(summary).toMatchObject({ checked: 1200, fresh: 1200, writes: 3 });
    expect(updates.map((u) => u.ids.length)).toEqual([500, 500, 200]);
  });
});

describe("revalidateCodeCitationsAfterIngest (#1831)", () => {
  it("returns the summary", async () => {
    const s = fn("a", "src/a.ts", 1, "h");
    const { prisma } = fakePrisma({ symbols: [s], links: [citing("l1", s)] });
    expect(await revalidateCodeCitationsAfterIngest(prisma, "g")).toMatchObject({ checked: 1 });
  });

  it("never throws: a fault leaves the links as they were", async () => {
    const prisma = {
      codeGraph: {
        findUnique: async () => {
          throw new Error("db down");
        },
      },
    } as unknown as RevalidatePrisma;
    await expect(revalidateCodeCitationsAfterIngest(prisma, "g")).resolves.toBeNull();
  });
});
