/**
 * Tests for docx + excel import providers (Epic #856, #861).
 *
 * These providers wrap third-party libraries (mammoth, exceljs) that we
 * lazy-import. The tests stub the underlying modules so we can exercise
 * the provider plumbing without committing binary fixtures.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("mammoth", () => {
  const convertToHtml = vi.fn(async () => ({
    value:
      "<h2>Login flow</h2><p>open the app</p><h3>Steps</h3><ul><li>visit /login</li><li>enter creds</li></ul><h3>Expected</h3><p>dashboard visible</p>",
  }));
  return { convertToHtml, default: { convertToHtml } };
});

vi.mock("exceljs", () => {
  class FakeRow {
    constructor(public values: (string | null)[]) {}
  }
  class FakeWorksheet {
    rows: FakeRow[] = [
      new FakeRow([null, "title", "steps", "expected"]),
      new FakeRow([null, "Login", "open;enter;submit", "dashboard"]),
      new FakeRow([null, "Logout", "click avatar;click logout", "login page"]),
    ];
    eachRow(_opts: { includeEmpty: boolean }, cb: (row: FakeRow, num: number) => void) {
      this.rows.forEach((r, i) => cb(r, i + 1));
    }
  }
  class FakeWorkbook {
    xlsx = { load: vi.fn(async () => undefined) };
    worksheets = [new FakeWorksheet()];
  }
  return {
    Workbook: FakeWorkbook,
    default: { Workbook: FakeWorkbook },
  };
});

describe("docxProvider", () => {
  it("rejects string input", async () => {
    const { docxProvider } =
      await import("../../../src/lib/testcoverage/providers/docx-provider.js");
    expect(() =>
      docxProvider.parse("not a buffer" as unknown as Buffer, { columnOverrides: {} }),
    ).toThrow(TypeError);
  });

  it("parses converted markdown into cases tagged docx", async () => {
    const { docxProvider } =
      await import("../../../src/lib/testcoverage/providers/docx-provider.js");
    const result = await docxProvider.parse(Buffer.from("ignored"), {
      columnOverrides: {},
    });
    expect(result.cases.length).toBeGreaterThan(0);
    expect(result.cases.every((c) => c.source === "docx")).toBe(true);
  });
});

describe("excelProvider", () => {
  it("rejects string input", async () => {
    const { excelProvider } =
      await import("../../../src/lib/testcoverage/providers/excel-provider.js");
    expect(() =>
      excelProvider.parse("not a buffer" as unknown as Buffer, { columnOverrides: {} }),
    ).toThrow(TypeError);
  });

  it("parses workbook rows into cases tagged excel", async () => {
    const { excelProvider } =
      await import("../../../src/lib/testcoverage/providers/excel-provider.js");
    const result = await excelProvider.parse(Buffer.from("xlsx-bytes"), {
      columnOverrides: {},
    });
    expect(result.cases).toHaveLength(2);
    expect(result.cases[0].title).toBe("Login");
    expect(result.cases.every((c) => c.source === "excel")).toBe(true);
  });

  it("re-exports providers from the barrel", async () => {
    const mod = await import("../../../src/lib/testcoverage/index.js");
    expect(typeof mod.csvProvider).toBe("object");
    expect(typeof mod.docxProvider).toBe("object");
    expect(typeof mod.excelProvider).toBe("object");
    expect(typeof mod.markdownProvider).toBe("object");
    expect(typeof mod.gherkinProvider).toBe("object");
    expect(typeof mod.resolveProvider).toBe("function");
  });
});
