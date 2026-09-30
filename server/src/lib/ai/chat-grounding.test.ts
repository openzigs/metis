/**
 * #18 — a chat reply says what it was grounded in. Unit tests for the
 * retrieval-outcome → grounding mapping and for reading it back off a row.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../prisma.js", () => ({
  prisma: {
    project: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id === "p-db" ? { name: "  Payments  " } : null,
      ),
    },
  },
}));

const { countProjectToolReads, describeGrounding, readGrounding, withToolReads } =
  await import("./chat-grounding.js");

describe("describeGrounding", () => {
  const named = async () => "Payments";

  it("is unscoped when the session has no project, whatever was retrieved", async () => {
    const lookup = vi.fn(named);
    expect(await describeGrounding(null, 1, lookup)).toEqual({ status: "unscoped" });
    expect(lookup).not.toHaveBeenCalled();
  });

  it("is grounded in the named project with its source count", async () => {
    expect(await describeGrounding("p1", 3, named)).toEqual({
      status: "grounded",
      projectId: "p1",
      projectName: "Payments",
      sources: 3,
    });
  });

  it("is no-context when the project is bound but nothing was retrieved", async () => {
    expect(await describeGrounding("p1", 0, named)).toEqual({
      status: "no-context",
      projectId: "p1",
      projectName: "Payments",
    });
  });

  it("falls back to a generic label when the name cannot be read", async () => {
    const failing = async () => {
      throw new Error("db down");
    };
    expect(await describeGrounding("p1", 1, failing)).toMatchObject({
      status: "grounded",
      projectName: "this project",
    });
    expect(await describeGrounding("p1", 0, async () => null)).toMatchObject({
      status: "no-context",
      projectName: "this project",
    });
  });

  it("reads the project name from the database by default", async () => {
    expect(await describeGrounding("p-db", 1)).toMatchObject({ projectName: "Payments" });
    expect(await describeGrounding("p-gone", 0)).toMatchObject({ projectName: "this project" });
  });
});

describe("countProjectToolReads (#439)", () => {
  const read = { source: "code" as const, executed: true, resultCount: 2 };

  it("counts each code-tool call that ran, succeeded and returned results", () => {
    expect(countProjectToolReads([read, { ...read, resultCount: 1 }])).toBe(2);
  });

  it.each([
    ["an empty result", { ...read, resultCount: 0 }],
    ["no result count", { source: "code" as const, executed: true }],
    ["a failed call", { ...read, isError: true }],
    ["a call that never ran", { ...read, executed: false }],
    ["an MCP tool", { ...read, source: "mcp" as const }],
    ["a METIS tool", { ...read, source: "metis" as const }],
    ["a sub-agent", { ...read, source: "agent" as const }],
    ["an unresolved tool", { executed: false, isError: true }],
  ])("does not count %s", (_label, call) => {
    expect(countProjectToolReads([call])).toBe(0);
  });
});

describe("withToolReads (#439)", () => {
  const noContext = { status: "no-context", projectId: "p1", projectName: "P" } as const;
  const grounded = { status: "grounded", projectId: "p1", projectName: "P", sources: 2 } as const;

  it("turns a no-context turn whose tools read the project into a grounded one", () => {
    expect(withToolReads(noContext, 3)).toEqual({
      status: "grounded",
      projectId: "p1",
      projectName: "P",
      sources: 0,
      toolReads: 3,
    });
  });

  it("adds the tool reads to a turn that already had excerpts", () => {
    expect(withToolReads(grounded, 1)).toEqual({ ...grounded, toolReads: 1 });
  });

  it("changes nothing when no tool read the project", () => {
    expect(withToolReads(noContext, 0)).toBe(noContext);
    expect(withToolReads(grounded, 0)).toBe(grounded);
  });

  it("keeps an unscoped turn unscoped", () => {
    expect(withToolReads({ status: "unscoped" }, 2)).toEqual({ status: "unscoped" });
  });

  it("produces a grounding the shared validator accepts", () => {
    expect(readGrounding({ grounding: withToolReads(noContext, 1) })).toEqual(
      withToolReads(noContext, 1),
    );
  });
});

describe("readGrounding", () => {
  it("round-trips each well-formed status", () => {
    for (const g of [
      { status: "unscoped" },
      { status: "no-context", projectId: "p1", projectName: "P" },
      { status: "grounded", projectId: "p1", projectName: "P", sources: 2 },
    ]) {
      expect(readGrounding({ grounding: g })).toEqual(g);
    }
  });

  it("drops extra keys rather than passing them through", () => {
    expect(readGrounding({ grounding: { status: "unscoped", secret: "x" } })).toEqual({
      status: "unscoped",
    });
  });

  it.each([
    ["no meta", undefined],
    ["null meta", null],
    ["no grounding", { cached: true }],
    ["non-object grounding", { grounding: "grounded" }],
    ["unknown status", { grounding: { status: "maybe" } }],
    ["no-context without a project", { grounding: { status: "no-context", projectName: "P" } }],
    ["grounded without a name", { grounding: { status: "grounded", projectId: "p", sources: 1 } }],
    [
      "grounded with zero sources",
      { grounding: { status: "grounded", projectId: "p", projectName: "P", sources: 0 } },
    ],
    [
      "grounded with fractional sources",
      { grounding: { status: "grounded", projectId: "p", projectName: "P", sources: 1.5 } },
    ],
  ])("reads %s as not known", (_label, meta) => {
    expect(readGrounding(meta as Record<string, unknown> | null | undefined)).toBeNull();
  });
});
