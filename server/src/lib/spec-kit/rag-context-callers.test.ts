/**
 * #944 items 2–4 — Spec Kit grounding lists the code that already CALLS a
 * retrieved symbol. Without it a plan missed the Fever and Google Reader
 * writers of the same table, and an analysis said `MarkAllAsReadBeforeDate`
 * "has no caller" while `internal/googlereader/handler.go:1225` calls it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSpecKitRagContext, type CallerEdgeRow } from "./rag-context.js";
import { __resetConfigSingleton } from "../config/config-service.js";

afterEach(() => __resetConfigSingleton());

const ENTRY = "internal/storage/entry.go";
const fusedCode = {
  searcher: {
    search: vi.fn(async () => [
      { symbolId: "s-mark", filePath: ENTRY, name: "MarkAllAsRead", kind: "function", score: 1 },
    ]),
  },
  lineLookup: {
    resolve: vi.fn(
      async () => new Map([["s-mark", { filePath: ENTRY, startLine: 506, endLine: 520 }]]),
    ),
  },
};
const siblings = {
  lookup: {
    findInFiles: vi.fn(async () => [
      {
        id: "s-before",
        name: "MarkAllAsReadBeforeDate",
        kind: "function",
        filePath: ENTRY,
        startLine: 523,
        endLine: 544,
      },
    ]),
  },
};
const noDocs = { search: vi.fn(async () => ({ hits: [] })) };

const edge = (over: Partial<CallerEdgeRow>): CallerEdgeRow => ({
  toSymbolId: null,
  toQualifiedName: null,
  filePath: "internal/ui/unread_mark_all_read.go",
  line: 17,
  callerName: "markAllAsRead",
  ...over,
});

describe("buildSpecKitRagContext — callers of retrieved symbols (#944)", () => {
  it("lists resolved and probable callers of retrieved symbols AND their siblings", async () => {
    const findCallers = vi.fn(async () => [
      edge({ toSymbolId: "s-mark" }),
      // Go call through a receiver: unbound, kept as a probable call site.
      edge({
        toQualifiedName: "MarkAllAsReadBeforeDate",
        filePath: "internal/googlereader/handler.go",
        line: 1225,
        callerName: "editTagHandler",
      }),
      edge({
        toQualifiedName: "h.store.MarkAllAsReadBeforeDate",
        filePath: "internal/fever/handler.go",
        line: 300,
        callerName: "handleWriteItems",
      }),
      // A test caller says nothing about who writes the table.
      edge({ toSymbolId: "s-mark", filePath: "internal/storage/entry_test.go", line: 9 }),
      // `endsWith` is case-insensitive in SQLite; the name must match exactly.
      edge({ toQualifiedName: "x.markallasreadbeforedate", filePath: "a.go", line: 1 }),
    ]);
    const res = await buildSpecKitRagContext("p1", "mark all as read older than N days", {
      knowledgeService: noDocs,
      fusedCode,
      includeCode: true,
      siblings,
      callers: { lookup: { findCallers } },
    });

    expect(res.context).toContain("## Callers of Retrieved Symbols");
    expect(res.context).toContain(
      "- MarkAllAsRead ← markAllAsRead at internal/ui/unread_mark_all_read.go:17",
    );
    expect(res.context).toContain(
      "- MarkAllAsReadBeforeDate ← editTagHandler at internal/googlereader/handler.go:1225 (probable)",
    );
    expect(res.context).toContain(
      "- MarkAllAsReadBeforeDate ← handleWriteItems at internal/fever/handler.go:300 (probable)",
    );
    expect(res.context).not.toContain("entry_test.go");
    expect(res.context).not.toContain("a.go:1");
    // Project-scoped, and asked about the sibling as well as the retrieved symbol.
    expect(findCallers).toHaveBeenCalledWith("p1", [
      { id: "s-mark", name: "MarkAllAsRead" },
      { id: "s-before", name: "MarkAllAsReadBeforeDate" },
    ]);
  });

  it("caps the list", async () => {
    const findCallers = vi.fn(async () =>
      Array.from({ length: 30 }, (_, i) => edge({ toSymbolId: "s-mark", line: i + 1 })),
    );
    const res = await buildSpecKitRagContext("p1", "q", {
      knowledgeService: noDocs,
      fusedCode,
      includeCode: true,
      callers: { lookup: { findCallers }, max: 3 },
    });
    expect(res.context.match(/^- MarkAllAsRead ← /gm)).toHaveLength(3);
  });

  it("adds nothing without the option, with no callers, or when the lookup fails", async () => {
    const off = await buildSpecKitRagContext("p1", "q", {
      knowledgeService: noDocs,
      fusedCode,
      includeCode: true,
    });
    expect(off.context).not.toContain("## Callers");
    const none = await buildSpecKitRagContext("p1", "q", {
      knowledgeService: noDocs,
      fusedCode,
      includeCode: true,
      callers: { lookup: { findCallers: vi.fn(async () => []) } },
    });
    expect(none.context).not.toContain("## Callers");
    const failing = await buildSpecKitRagContext("p1", "q", {
      knowledgeService: noDocs,
      fusedCode,
      includeCode: true,
      callers: { lookup: { findCallers: vi.fn().mockRejectedValue(new Error("db down")) } },
    });
    expect(failing.context).toContain("MarkAllAsRead");
    expect(failing.context).not.toContain("## Callers");
  });
});
