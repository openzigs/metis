/**
 * #246 / #224 — the `grounding-failed` warning and the unread-source-files
 * warning: their wording, their line in the summary, and the status they force.
 */
import { describe, expect, it } from "vitest";
import {
  deriveDocStatus,
  groundingFailedWarning,
  groundingModeRunWarning,
  groundingSampledWarning,
  SOURCE_FILES_MISSING_REMEDY,
  SOURCE_FILES_REFUSED_NOTE,
  SOURCE_FILES_SECTION,
  SOURCE_FILES_UNREADABLE_REMEDY,
  sourceFilesUnreadWarning,
  sourceUnavailableWarning,
  summarizeWarnings,
} from "./degraded-warnings.js";

describe("#246 groundingFailedWarning", () => {
  it("names the section and the error class, and degrades the document", () => {
    const w = groundingFailedWarning("Integrations & Glossary", "the connection was dropped");
    expect(w).toMatchObject({ kind: "grounding-failed", section: "Integrations & Glossary" });
    expect(w.message).toContain('Section "Integrations & Glossary" was NOT fact-checked');
    expect(w.message).toContain("(the connection was dropped)");
    expect(deriveDocStatus([w])).toBe("degraded");
  });

  it("is counted apart from spot-checked sections", () => {
    const sampled = groundingSampledWarning(
      "Overview",
      { supportedClaims: 9, totalClaims: 10, faithfulness: 0.9, threshold: 0.8 },
      { rate: 0.25, passagesChecked: 1, passagesTotal: 4, charsChecked: 10, charsTotal: 40 },
    );
    const summary = summarizeWarnings([
      sampled,
      groundingFailedWarning("Integrations", "x"),
      groundingModeRunWarning({ mode: "sample", sampleRate: 0.25 })!,
    ]);
    expect(summary).toContain("1 section(s) could not be fact-checked");
    expect(summary).toContain("1 section(s) were only spot-checked");
    expect(summary).toMatch(/^Needs review/);
  });
});

describe("#224 sourceFilesUnreadWarning", () => {
  const files = [
    { module: "orders", file: "src/orders/gone.ts", cause: "missing" as const },
    { module: "orders", file: "src/orders/locked.ts", cause: "unreadable" as const },
    { module: "billing", file: "src/billing/link.ts", cause: "refused" as const },
  ];

  it("names every file with the remedy for its cause", () => {
    const w = sourceFilesUnreadWarning(files);
    expect(w).toMatchObject({ kind: "source-unavailable", section: SOURCE_FILES_SECTION });
    expect(w.message).toContain("3 code file(s) in 2 module(s)");
    expect(w.message).toContain(`src/orders/gone.ts. ${SOURCE_FILES_MISSING_REMEDY}`);
    expect(w.message).toContain(`src/orders/locked.ts. ${SOURCE_FILES_UNREADABLE_REMEDY}`);
    expect(w.message).toContain(`src/billing/link.ts. ${SOURCE_FILES_REFUSED_NOTE}`);
  });

  it("lists at most ten files per cause", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      module: "m",
      file: `f${i}.ts`,
      cause: "missing" as const,
    }));
    expect(sourceFilesUnreadWarning(many).message).toContain("and 2 more");
  });

  it("gets its own summary lines, not the whole-module re-ingest line (#330)", () => {
    const summary = summarizeWarnings([sourceFilesUnreadWarning(files)]);
    expect(summary).toMatch(/^Degraded output/);
    expect(summary).toContain("missing from the clone");
    expect(summary).toContain("give the server read access");
    expect(summary).toContain("refused by design");
    expect(summary).not.toContain("source code could not be read");
  });

  it("prints only the remedies of the causes present", () => {
    const summary = summarizeWarnings([sourceFilesUnreadWarning([files[1]])]);
    expect(summary).toContain("give the server read access");
    expect(summary).not.toContain("missing from the clone");
    expect(summary).not.toContain("refused by design");
  });

  it("keeps the #330 line for a wholly unreadable module", () => {
    expect(summarizeWarnings([sourceUnavailableWarning(1, 2)])).toContain(
      "source code could not be read",
    );
  });
});
