/**
 * #2272 — the requirements a portfolio check reads from a document, and what
 * it lists as not checked. The document is a stored Markdown file read through
 * the real parser; the model reading is a double.
 */
import { describe, expect, it, vi } from "vitest";
import { PORTFOLIO_MAX_REQUIREMENTS, PORTFOLIO_REQUIREMENT_MAX_CHARS } from "@metis/shared";
import type { DocumentReading, ReadStatement, SectionCoverage } from "../document-reader/reader.js";
import {
  NOT_CHECKED_LISTED_PER_REASON,
  NoDocumentRequirementsError,
  boundedRequirements,
  cutText,
  requirementsFromDocument,
  type DocumentRequirementsDeps,
} from "./document-requirements.js";

const FRD = [
  "# Payments FRD",
  "",
  "## Refunds",
  "",
  "- A refund posts a ledger entry.",
  "- A refund is emailed to the customer.",
  "",
].join("\n");

function deps(over: Partial<DocumentRequirementsDeps> = {}, text = FRD): DocumentRequirementsDeps {
  return {
    prisma: {
      document: {
        findFirst: vi.fn(async () => ({ id: "doc-1" })),
        findUnique: vi.fn(async () => ({
          projectId: "proj-1",
          checksum: "sha-frd",
          filename: "frd.md",
          title: "Payments FRD",
          mimeType: "text/markdown",
          storagePath: "docs/frd.md",
        })),
      },
      knowledgeChunk: { findMany: vi.fn(async () => []) },
      quarantineChunk: { findMany: vi.fn(async () => []) },
    } as unknown as DocumentRequirementsDeps["prisma"],
    storage: { read: vi.fn(async () => Buffer.from(text, "utf-8")) },
    extractor: {
      extract: vi.fn(async (t: string) =>
        t
          .split("\n")
          .filter((l) => l.startsWith("- "))
          .map((l) => ({
            requirementId: null,
            title: l.slice(2, 30),
            body: l.slice(2),
            changeType: "added" as const,
            bodyDelta: l.length,
          })),
      ),
    },
    ...over,
  };
}

const statement = (over: Partial<ReadStatement>): ReadStatement => ({
  id: "T1",
  kind: "requirement",
  statement: "A refund posts a ledger entry",
  quote: "A refund posts a ledger entry.",
  start: 0,
  end: 10,
  sectionId: "S1",
  headingPath: ["Payments FRD", "Refunds"],
  refersTo: [],
  ...over,
});

const section = (over: Partial<SectionCoverage>): SectionCoverage => ({
  sectionId: "S1",
  headingPath: ["Payments FRD", "Refunds"],
  start: 0,
  end: 10,
  status: "read",
  kinds: { requirement: 1 },
  statements: 1,
  unverified: 0,
  repeats: 0,
  ...over,
});

function reading(over: Partial<DocumentReading>): DocumentReading {
  return {
    mode: "whole",
    statements: [],
    sections: [],
    droppedUnverified: 0,
    merge: "skipped",
    calls: 1,
    outputTokenCap: 1000,
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    ...over,
  };
}

describe("requirementsFromDocument (#2272)", () => {
  it("with the reader: one requirement per requirement, constraint or rule it found, in its section", async () => {
    const reader = vi.fn(async () => ({
      reading: reading({
        statements: [
          statement({}),
          statement({ id: "T2", kind: "background", statement: "Refunds are common" }),
          statement({
            id: "T3",
            kind: "business-rule",
            statement: "Refunds over 1k need approval",
          }),
          statement({
            id: "T4",
            kind: "constraint",
            statement: "Within 2 seconds",
            headingPath: [],
          }),
        ],
        sections: [
          section({}),
          section({ sectionId: "S2", headingPath: ["Payments FRD", "Appendix"], status: "unread" }),
        ],
        droppedUnverified: 2,
      }),
      costUsd: 0.12,
    }));
    const d = deps({ reader });
    const read = await requirementsFromDocument("doc-1", d);
    // #2280 — with the stored document's key, so a saved reading of it can be reused.
    expect(reader).toHaveBeenCalledWith({
      title: "Payments FRD",
      text: expect.stringContaining("ledger"),
      document: { projectId: "proj-1", documentId: "doc-1", checksum: "sha-frd" },
    });
    expect(read.criteria).toEqual([
      "A refund posts a ledger entry (section: Payments FRD › Refunds)",
      "Refunds over 1k need approval (section: Payments FRD › Refunds)",
      // No heading path: no section named.
      "Within 2 seconds",
    ]);
    expect(read.notChecked).toEqual([
      { text: "Payments FRD › Appendix", reason: "section-unread", count: null },
      { text: "Statements the model read", reason: "quote-not-found", count: 2 },
    ]);
    expect(read.costUsd).toBe(0.12);
    expect(read.statement).toBe(
      'Requirements read from "Payments FRD": the model read it in full and found 3 requirements. Each is checked on its own.',
    );
    expect(d.extractor.extract).not.toHaveBeenCalled();
  });

  it("without the reader: the splitter's parts, and the statement says so", async () => {
    const read = await requirementsFromDocument("doc-1", deps());
    expect(read.criteria).toEqual([
      "A refund posts a ledger entry.",
      "A refund is emailed to the customer.",
    ]);
    expect(read.notChecked).toEqual([]);
    expect(read.costUsd).toBe(0);
    expect(read.statement).toContain(
      "the splitter (one per paragraph or bullet; the document reader is off) found 2 requirements",
    );
  });

  it("#2280 — a saved reading reused says whose it is", async () => {
    const reader = vi.fn(async () => ({
      reading: reading({
        statements: [statement({ headingPath: [] })],
        reused: { readAt: new Date("2026-11-10T09:00:00Z"), model: "claude-sonnet-5-5" },
      }),
      costUsd: 0,
    }));
    const read = await requirementsFromDocument("doc-1", deps({ reader }));
    expect(read.statement).toBe(
      'Requirements read from "Payments FRD": the model\'s saved reading of it (claude-sonnet-5-5, 2026-11-10) found 1 requirement. It is checked on its own.',
    );
    expect(read.costUsd).toBe(0);
  });

  it("a failed reading falls back to the splitter, and the statement says so", async () => {
    const reader = vi.fn(async () => {
      throw new Error("provider down");
    });
    const read = await requirementsFromDocument("doc-1", deps({ reader }));
    expect(read.criteria).toHaveLength(2);
    expect(read.statement).toContain("the model could not read it, so the splitter");
  });

  it("one requirement found reads in the singular", async () => {
    const read = await requirementsFromDocument("doc-1", deps({}, "# One\n\n- Only this one.\n"));
    expect(read.statement).toContain("found 1 requirement. It is checked on its own.");
  });

  it("requirements past the cap are listed, and the statement says how many", async () => {
    const many = Array.from({ length: PORTFOLIO_MAX_REQUIREMENTS + 3 }, (_, i) => `- Req ${i + 1}`);
    const read = await requirementsFromDocument("doc-1", deps({}, `# Big\n\n${many.join("\n")}\n`));
    expect(read.criteria).toHaveLength(PORTFOLIO_MAX_REQUIREMENTS);
    expect(read.notChecked.map((n) => [n.text, n.reason])).toEqual([
      [`Req ${PORTFOLIO_MAX_REQUIREMENTS + 1}`, "over-limit"],
      [`Req ${PORTFOLIO_MAX_REQUIREMENTS + 2}`, "over-limit"],
      [`Req ${PORTFOLIO_MAX_REQUIREMENTS + 3}`, "over-limit"],
    ]);
    expect(read.statement).toContain(
      `found ${PORTFOLIO_MAX_REQUIREMENTS + 3} requirements. The first ${PORTFOLIO_MAX_REQUIREMENTS} are each checked on their own; the other 3 are listed as not checked.`,
    );
  });

  it("refuses a document deleted since the check started, before reading it", async () => {
    const d = deps();
    (d.prisma.document.findFirst as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    await expect(requirementsFromDocument("doc-1", d)).rejects.toThrow(
      new NoDocumentRequirementsError("The document was deleted before the check could read it."),
    );
    expect(d.prisma.document.findFirst).toHaveBeenCalledWith({
      where: { id: "doc-1", deletedAt: null },
      select: { id: true },
    });
    expect(d.storage.read).not.toHaveBeenCalled();
  });

  it("refuses a document with no text, or none that reads as a requirement", async () => {
    await expect(requirementsFromDocument("doc-1", deps({}, "   "))).rejects.toBeInstanceOf(
      NoDocumentRequirementsError,
    );
    const reader = vi.fn(async () => ({ reading: reading({}), costUsd: 0 }));
    await expect(requirementsFromDocument("doc-1", deps({ reader }))).rejects.toThrow(
      "No requirement was found in the document.",
    );
  });
});

describe("boundedRequirements and cutText (#2272)", () => {
  it("cuts a requirement past its length and says how much was cut", () => {
    const long = `Start ${"x".repeat(PORTFOLIO_REQUIREMENT_MAX_CHARS)}`;
    const { criteria, notChecked } = boundedRequirements([long, "  ", "short"]);
    expect(criteria).toEqual([long.slice(0, PORTFOLIO_REQUIREMENT_MAX_CHARS), "short"]);
    expect(notChecked).toHaveLength(1);
    expect(notChecked[0].reason).toBe("text-cut");
    expect(notChecked[0].count).toBe(long.length - PORTFOLIO_REQUIREMENT_MAX_CHARS);
    expect(notChecked[0].text.startsWith("Start x")).toBe(true);
    expect(notChecked[0].text.endsWith("…")).toBe(true);
  });

  it("lists past-the-cap requirements one by one, then counts the rest in one entry", () => {
    const extra = NOT_CHECKED_LISTED_PER_REASON + 5;
    const texts = Array.from({ length: PORTFOLIO_MAX_REQUIREMENTS + extra }, (_, i) => `R${i}`);
    const { criteria, notChecked } = boundedRequirements(texts);
    expect(criteria).toHaveLength(PORTFOLIO_MAX_REQUIREMENTS);
    expect(notChecked).toHaveLength(NOT_CHECKED_LISTED_PER_REASON + 1);
    expect(notChecked.at(-1)).toEqual({
      text: "5 more requirements",
      reason: "over-limit",
      count: 5,
    });
  });

  it("leaves a text that fits as it is", () => {
    expect(cutText("abc", 3)).toEqual({ text: "abc", entry: null });
    expect(cutText("abcd", 3)).toEqual({
      text: "abc",
      entry: { text: "abcd", reason: "text-cut", count: 1 },
    });
  });
});
