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

const { describeGrounding, readGrounding } = await import("./chat-grounding.js");

describe("describeGrounding", () => {
  const named = async () => "Payments";

  it("is unscoped when the session has no project, whatever was retrieved", async () => {
    const lookup = vi.fn(named);
    expect(await describeGrounding(null, ["ctx"], lookup)).toEqual({ status: "unscoped" });
    expect(lookup).not.toHaveBeenCalled();
  });

  it("is grounded in the named project with one source per retrieved context", async () => {
    expect(await describeGrounding("p1", ["a", "b", "c"], named)).toEqual({
      status: "grounded",
      projectId: "p1",
      projectName: "Payments",
      sources: 3,
    });
  });

  it("is no-context when the project is bound but nothing was retrieved", async () => {
    expect(await describeGrounding("p1", [], named)).toEqual({
      status: "no-context",
      projectId: "p1",
      projectName: "Payments",
    });
  });

  it("falls back to a generic label when the name cannot be read", async () => {
    const failing = async () => {
      throw new Error("db down");
    };
    expect(await describeGrounding("p1", ["a"], failing)).toMatchObject({
      status: "grounded",
      projectName: "this project",
    });
    expect(await describeGrounding("p1", [], async () => null)).toMatchObject({
      status: "no-context",
      projectName: "this project",
    });
  });

  it("reads the project name from the database by default", async () => {
    expect(await describeGrounding("p-db", ["a"])).toMatchObject({ projectName: "Payments" });
    expect(await describeGrounding("p-gone", [])).toMatchObject({ projectName: "this project" });
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
