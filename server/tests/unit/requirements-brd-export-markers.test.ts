/**
 * #1170 — analysts hand the BRD over as a file, so the exported Markdown, PDF
 * and DOCX of a requirements-scoped document must carry neither form of the
 * clarification markers (raw or escaped into text), and must keep every
 * requirement and the clarification answers themselves.
 */
import { describe, expect, it, vi } from "vitest";
import JSZip from "jszip";

const contents: string[] = [];
vi.mock("puppeteer", () => ({
  default: {
    launch: async () => ({
      newPage: async () => ({
        setViewport: async () => {},
        setContent: async (html: string) => void contents.push(html),
        addScriptTag: async () => {},
        evaluate: async () => {},
        waitForSelector: async () => null,
        pdf: async () => Buffer.from("PDF"),
      }),
      close: async () => {},
    }),
  },
}));
vi.mock("../../src/lib/prisma.js", () => ({ prisma: {} }));

import { exportDocument } from "../../src/lib/docs-gen/exporters.js";
import {
  renderRequirementsDocument,
  type ScopedRequirement,
} from "../../src/lib/docs-gen/requirements-scope.js";

function requirement(n: number): ScopedRequirement {
  return {
    id: `r${n}`,
    title: `Requirement ${n}`,
    body: [
      `Body ${n}.`,
      "",
      "<!-- metis:clarifications:start -->",
      "## Clarifications",
      "",
      "> **Check the acceptance criteria.** <!-- metis:criteria-predate-answers -->",
      "",
      `- **Q:** Question ${n}?`,
      `  **A:** Answer ${n}.`,
      "<!-- metis:clarifications:end -->",
    ].join("\n"),
    type: "feature",
    priority: "medium",
    reviewStatus: "approved",
    verdict: "gap-confirmed",
    acceptanceCriteria: JSON.stringify([`Criterion ${n}.`]),
    version: 1,
    updatedAt: new Date("2026-10-16T00:00:00Z"),
    codeMappings: [],
    implementations: [],
  };
}

const markdown = renderRequirementsDocument(
  "BRD",
  { analysisId: "cmv-internal-run-id", requirementIds: ["r1", "r2", "r3"] },
  [1, 2, 3].map(requirement),
  { analysisStartedAt: new Date("2026-10-16T04:48:09Z") },
);

function expectWholeAndClean(text: string): void {
  expect(text).not.toMatch(/metis:/);
  expect(text).not.toContain("cmv-internal-run-id");
  for (const n of [1, 2, 3]) {
    expect(text).toContain(`Requirement ${n}`);
    expect(text).toContain(`Answer ${n}.`);
    expect(text).toContain(`Criterion ${n}.`);
  }
}

describe("requirements BRD exports — #1170", () => {
  it("Markdown", async () => {
    const out = await exportDocument(markdown, "BRD", "markdown");
    expectWholeAndClean(out.buffer.toString("utf-8"));
  });

  it("PDF", async () => {
    contents.length = 0;
    await exportDocument(markdown, "BRD", "pdf");
    expectWholeAndClean(contents[0] ?? "");
  });

  it("DOCX", async () => {
    const out = await exportDocument(markdown, "BRD", "docx");
    const zip = await JSZip.loadAsync(out.buffer);
    const xml = (await zip.file("word/document.xml")?.async("string")) ?? "";
    expectWholeAndClean(xml.replace(/<[^>]+>/g, ""));
  });
});
