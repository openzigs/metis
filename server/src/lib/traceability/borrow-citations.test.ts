/**
 * #1839 — borrowing a similar requirement's saved code links, against an
 * in-memory fake Prisma that applies the `where` it is given (so a query that
 * drops its project scope reads the other project's rows here, and the test
 * goes red). The real-DB path, the route and the read-back are in
 * `server/tests/borrow-citations-1839.sqlite.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const noteRequirementCodeLinksChanged = vi.hoisted(() => vi.fn());
vi.mock("../docs-gen/approved-requirements-staleness.js", () => ({
  noteRequirementCodeLinksChanged,
}));

import {
  BORROWED_CONFIDENCE_CAP,
  borrowCitations,
  hideSupersededBorrowedLinks,
  type BorrowCitationsDeps,
} from "./borrow-citations.js";
import { DEFAULT_SEED_CONFIDENCE } from "./seed-code-links-from-findings.js";

interface Req {
  id: string;
  projectId: string;
  deletedAt: Date | null;
}
interface Link {
  id: string;
  requirementId: string;
  projectId: string;
  codeSymbolId: string | null;
  filePath: string;
  startLine: number | null;
  endLine: number | null;
  confidence: number;
  source: string;
  originRequirementId: string | null;
  codeGraphId: string | null;
  commitSha: string | null;
  freshness: string;
  validatedAt: Date | null;
  symbolQualifiedName: string | null;
  symbolKind: string | null;
  symbolContentHash: string | null;
  createdAt: Date;
}

type Where = Record<string, unknown>;
function matches(row: Record<string, unknown>, where: Where): boolean {
  return Object.entries(where).every(([k, cond]) => {
    const v = row[k];
    if (cond && typeof cond === "object" && !(cond instanceof Date)) {
      const c = cond as { in?: unknown[]; not?: unknown };
      if (c.in) return c.in.includes(v);
      if ("not" in c) return v !== c.not;
    }
    return v === cond;
  });
}

const P = "p-1";
const OTHER = "p-2";
const VALIDATED = new Date("2026-11-01T00:00:00.000Z");

let reqs: Req[];
let links: Link[];
let seq = 0;

function link(over: Partial<Link> & Pick<Link, "requirementId" | "filePath">): Link {
  seq += 1;
  return {
    id: `m-${seq}`,
    projectId: P,
    codeSymbolId: `s-${over.filePath}`,
    startLine: 1,
    endLine: 9,
    confidence: 0.9,
    source: "analysis-grounding",
    originRequirementId: null,
    codeGraphId: "g-1",
    commitSha: "abc",
    freshness: "fresh",
    validatedAt: VALIDATED,
    symbolQualifiedName: `${over.filePath}::fn`,
    symbolKind: "function",
    symbolContentHash: "h",
    createdAt: new Date(2026, 10, 1, 0, 0, seq),
    ...over,
  };
}

function fakePrisma(): BorrowCitationsDeps["prisma"] {
  return {
    requirement: {
      findMany: async ({ where }: { where: Where }) =>
        reqs.filter((r) => matches(r as never, where)).map((r) => ({ id: r.id })),
    },
    requirementCodeMapping: {
      findMany: async ({ where }: { where: Where }) =>
        links
          .filter((l) => matches(l as never, where))
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
      createMany: async ({ data }: { data: Omit<Link, "id" | "createdAt">[] }) => {
        for (const d of data) {
          seq += 1;
          links.push({ ...d, id: `m-${seq}`, createdAt: new Date(2026, 10, 2, 0, 0, seq) });
        }
        return { count: data.length };
      },
    },
  } as unknown as BorrowCitationsDeps["prisma"];
}

const borrow = (to: string, from: string, mappingIds?: string[]) =>
  borrowCitations(
    P,
    to,
    { fromRequirementId: from, ...(mappingIds ? { mappingIds } : {}) },
    {
      prisma: fakePrisma(),
    },
  );
const rowsOf = (requirementId: string) => links.filter((l) => l.requirementId === requirementId);

beforeEach(() => {
  noteRequirementCodeLinksChanged.mockReset();
  seq = 0;
  reqs = [
    { id: "to", projectId: P, deletedAt: null },
    { id: "from", projectId: P, deletedAt: null },
    { id: "elsewhere", projectId: OTHER, deletedAt: null },
    { id: "gone", projectId: P, deletedAt: new Date() },
  ];
  links = [];
});

describe("borrowCitations (#1839)", () => {
  it("copies a fresh link as a similar-requirement suggestion naming its origin", async () => {
    links.push(link({ requirementId: "from", filePath: "src/a.ts" }));
    const result = await borrow("to", "from");
    expect(result).toEqual({ copied: 1, skippedStale: 0, skippedDuplicate: 0 });
    const [copy] = rowsOf("to");
    expect(copy).toMatchObject({
      projectId: P,
      source: "similar-requirement",
      originRequirementId: "from",
      filePath: "src/a.ts",
      codeSymbolId: "s-src/a.ts",
      startLine: 1,
      endLine: 9,
      codeGraphId: "g-1",
      commitSha: "abc",
      freshness: "fresh",
      validatedAt: VALIDATED,
      symbolQualifiedName: "src/a.ts::fn",
      symbolKind: "function",
      symbolContentHash: "h",
    });
    expect(noteRequirementCodeLinksChanged).toHaveBeenCalledWith(["to"]);
  });

  it("caps the copy's confidence below an analysis-seeded link's default", async () => {
    links.push(
      link({ requirementId: "from", filePath: "src/sure.ts", confidence: 1 }),
      link({ requirementId: "from", filePath: "src/unsure.ts", confidence: 0.2 }),
    );
    await borrow("to", "from");
    expect(BORROWED_CONFIDENCE_CAP).toBeLessThan(DEFAULT_SEED_CONFIDENCE);
    const byFile = new Map(rowsOf("to").map((r) => [r.filePath, r.confidence]));
    expect(byFile.get("src/sure.ts")).toBe(BORROWED_CONFIDENCE_CAP);
    expect(byFile.get("src/unsure.ts")).toBe(0.2);
  });

  it("copies a moved link, and skips stale and unverified ones as needing a re-check", async () => {
    links.push(
      link({ requirementId: "from", filePath: "src/moved.ts", freshness: "moved" }),
      link({ requirementId: "from", filePath: "src/stale.ts", freshness: "stale" }),
      link({ requirementId: "from", filePath: "src/never.ts", freshness: "unverified" }),
    );
    const result = await borrow("to", "from");
    expect(result).toEqual({ copied: 1, skippedStale: 2, skippedDuplicate: 0 });
    expect(rowsOf("to").map((r) => [r.filePath, r.freshness])).toEqual([["src/moved.ts", "moved"]]);
  });

  it("borrowing twice copies nothing the second time", async () => {
    links.push(
      link({ requirementId: "from", filePath: "src/a.ts" }),
      link({ requirementId: "from", filePath: "src/b.ts" }),
    );
    expect(await borrow("to", "from")).toEqual({ copied: 2, skippedStale: 0, skippedDuplicate: 0 });
    expect(await borrow("to", "from")).toEqual({ copied: 0, skippedStale: 0, skippedDuplicate: 2 });
    expect(rowsOf("to")).toHaveLength(2);
    expect(noteRequirementCodeLinksChanged).toHaveBeenCalledTimes(1);
  });

  it("counts two origin links to the same code once", async () => {
    links.push(
      link({ requirementId: "from", filePath: "src/a.ts", source: "manual" }),
      link({ requirementId: "from", filePath: "src/a.ts", source: "analysis-grounding" }),
    );
    expect(await borrow("to", "from")).toEqual({ copied: 1, skippedStale: 0, skippedDuplicate: 1 });
  });

  it("skips code the requirement already links under any source, and files its analysis grounded", async () => {
    links.push(
      link({ requirementId: "to", filePath: "src/manual.ts", source: "manual" }),
      link({
        requirementId: "to",
        filePath: "src/grounded.ts",
        codeSymbolId: "other-symbol",
        source: "analysis-grounding",
      }),
      link({ requirementId: "from", filePath: "src/manual.ts" }),
      link({ requirementId: "from", filePath: "src/grounded.ts" }),
      link({ requirementId: "from", filePath: "src/new.ts" }),
    );
    expect(await borrow("to", "from")).toEqual({ copied: 1, skippedStale: 0, skippedDuplicate: 2 });
    expect(
      rowsOf("to")
        .filter((r) => r.source === "similar-requirement")
        .map((r) => r.filePath),
    ).toEqual(["src/new.ts"]);
  });

  it("does not lend on a link that was itself borrowed", async () => {
    links.push(
      link({
        requirementId: "from",
        filePath: "src/hearsay.ts",
        source: "similar-requirement",
        originRequirementId: "third",
      }),
    );
    expect(await borrow("to", "from")).toEqual({ copied: 0, skippedStale: 0, skippedDuplicate: 0 });
    expect(noteRequirementCodeLinksChanged).not.toHaveBeenCalled();
  });

  it("copies only the named mapping ids, and only the origin's own", async () => {
    const a = link({ requirementId: "from", filePath: "src/a.ts" });
    const b = link({ requirementId: "from", filePath: "src/b.ts" });
    const foreign = link({ requirementId: "third", filePath: "src/c.ts" });
    links.push(a, b, foreign);
    expect(await borrow("to", "from", [b.id, foreign.id])).toEqual({
      copied: 1,
      skippedStale: 0,
      skippedDuplicate: 0,
    });
    expect(rowsOf("to").map((r) => r.filePath)).toEqual(["src/b.ts"]);
  });

  it("never reads a link of the origin requirement held under another project", async () => {
    links.push(link({ requirementId: "from", filePath: "src/x.ts", projectId: OTHER }));
    expect(await borrow("to", "from")).toEqual({ copied: 0, skippedStale: 0, skippedDuplicate: 0 });
  });

  it.each([
    ["another project's requirement", "to", "elsewhere"],
    ["a deleted requirement", "to", "gone"],
    ["an unknown requirement", "to", "nope"],
    ["a target in another project", "elsewhere", "from"],
  ])("answers 404 for %s, copying nothing", async (_label, to, from) => {
    links.push(link({ requirementId: from, filePath: "src/a.ts" }));
    await expect(borrow(to, from)).rejects.toMatchObject({
      statusCode: 404,
      code: "REQUIREMENT_NOT_FOUND",
    });
    expect(links.filter((l) => l.source === "similar-requirement")).toHaveLength(0);
  });
});

describe("hideSupersededBorrowedLinks (#1839)", () => {
  const row = (source: string, filePath: string) => ({ source, filePath });

  it("drops a borrowed link into a file the requirement's own analysis grounded", () => {
    const rows = [
      row("analysis-grounding", "src/a.ts"),
      row("similar-requirement", "src/a.ts"),
      row("similar-requirement", "src/b.ts"),
      row("manual", "src/b.ts"),
    ];
    expect(hideSupersededBorrowedLinks(rows)).toEqual([
      row("analysis-grounding", "src/a.ts"),
      row("similar-requirement", "src/b.ts"),
      row("manual", "src/b.ts"),
    ]);
  });

  it("keeps every row when nothing was borrowed", () => {
    const rows = [row("analysis-grounding", "src/a.ts"), row("semantic", "src/a.ts")];
    expect(hideSupersededBorrowedLinks(rows)).toEqual(rows);
  });
});
