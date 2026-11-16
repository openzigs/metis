/**
 * #2595 — the BA hand-off through the generated-docs export pipeline: the Word
 * and PDF a BA sends on carry every part of the document, and text from a
 * person or a document is shown as text in both (the PDF is rendered from HTML).
 * Chromium is a recorder here (#447): the HTML the PDF page is given is read back.
 */
import { describe, expect, it, vi } from "vitest";
import JSZip from "jszip";

const pages: string[] = [];
vi.mock("puppeteer", () => ({
  default: {
    launch: async () => ({
      newPage: async () => ({
        setRequestInterception: async () => {},
        on: () => {},
        setViewport: async () => {},
        setContent: async (html: string) => void pages.push(html),
        addScriptTag: async () => {},
        addStyleTag: async () => {},
        evaluate: async () => {},
        waitForSelector: async () => null,
        pdf: async () => Buffer.from("PDF"),
      }),
      close: async () => {},
    }),
  },
}));

const { exportDocument } = await import("../../src/lib/docs-gen/exporters.js");
const { handoffTitle, serializeHandoffMarkdown } =
  await import("../../src/lib/impact-analysis/handoff-export.js");

const input = {
  detail: {
    id: "ia-1",
    status: "completed",
    documentId: null,
    sourceText: null,
    summary: "Keys & sessions change.",
    errorMessage: null,
    rerunOfId: null,
    totalImpactedSymbols: 1,
    startedAt: "2026-11-16T10:00:00.000Z",
    completedAt: "2026-11-16T10:05:00.000Z",
    projectIds: ["project-001"],
    startedById: "user-1",
    projectOutcomes: [],
    sharedTableImpacts: [],
    items: [
      {
        id: "item-1",
        projectId: "project-001",
        requirementId: "r-1",
        requirementTitle: "Keys can expire",
        changeType: "modified",
        severity: "high",
        impactScore: 0.7,
        confidence: 0.7,
        matchQuality: "strong",
        matchQualityReason: null,
        affectedFileCount: 1,
        affectedSymbolCount: 1,
        summary: null,
        affectedSymbols: [
          {
            id: "s-1",
            codeSymbolId: "cs-1",
            filePath: "internal/storage/api_key.go",
            qualifiedName: "internal/storage/api_key.go::Storage::CreateAPIKey",
            startLine: 73,
            endLine: 101,
            relation: "direct",
            depth: 0,
            confidence: 0.95,
          },
        ],
        affectedTables: [],
        affectedTablesSecondary: [],
        affectedTests: [],
        writePathGaps: [],
        editCandidateFiles: [],
        blastRadiusFiles: [],
        droppedColumnProposals: [],
        optionalColumnProposals: [],
        uncheckedColumnProposals: [],
        feedback: [],
      },
    ],
  },
  projectNames: { "project-001": "Miniflux" },
  changeRequest: {
    title: "Expiring API keys",
    restrictedLeftOut: 0,
    passagesWithheld: false,
    requirements: [
      {
        title: "Keys can expire <img src=x onerror=alert(1)>",
        body: "Terms & conditions apply. <script>alert(1)</script>",
        approved: true,
        verdict: "could-not-verify",
        passages: [{ filename: "FRD.md", headingPath: ["Keys"], quote: "A key may expire." }],
      },
    ],
  },
  impactClarifications: [{ subject: "Keys", question: "Date or time?", answer: "Date only" }],
} as Parameters<typeof serializeHandoffMarkdown>[0];

const markdown = serializeHandoffMarkdown(input);
const title = handoffTitle(input);

function expectWhole(text: string): void {
  for (const part of [
    "Expiring API keys",
    "Summary",
    "Requirements",
    "Affected files and code citations",
    "Clarifications answered",
    "Risks",
    "Open items: could not verify",
    "A key may expire.",
    "Storage::CreateAPIKey",
    "Date only",
  ]) {
    expect(text).toContain(part);
  }
}

describe("the hand-off as Word and PDF — #2595", () => {
  it("Word carries the whole document, with the analyst's text as written", async () => {
    const out = await exportDocument(markdown, title, "docx");
    expect(out.mimeType).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(out.filename).toBe("Expiring API keys - impact hand-off.docx");
    const zip = await JSZip.loadAsync(out.buffer);
    const xml = (await zip.file("word/document.xml")?.async("string")) ?? "";
    const text = [...xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join("");
    expectWhole(text);
    // `&` is the analyst's own character, escaped once by the XML and no more.
    expect(text).toContain("Keys &amp; sessions change.");
    expect(text).toContain("Terms &amp; conditions apply.");
    expect(text).not.toContain("&amp;amp;");
  });

  it("PDF carries the whole document, and renders no HTML from the text", async () => {
    pages.length = 0;
    const out = await exportDocument(markdown, title, "pdf");
    expect(out.mimeType).toBe("application/pdf");
    const html = pages[0] ?? "";
    expectWhole(html);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });
});
