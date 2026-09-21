/**
 * #1360 — internal grounding source ids must not reach the reader.
 *
 * Measured before the fix: 1,427 `[facts:…]` markers across 11 of 29 generated
 * documents in a real database. The 20 percent-encoded ones all came from the
 * repository-scoped identity #1354 introduced, which is a URL-encoded JSON array
 * and renders as an unreadable 130-character blob.
 *
 * These tests pin the shape of the stripper, not just the happy path: the point
 * is that it removes ids WITHOUT damaging the surrounding document.
 */
import { describe, it, expect } from "vitest";
import { stripLeakedSourceIds } from "./holistic-synthesizer.js";

describe("stripLeakedSourceIds (#1360)", () => {
  it("removes the legacy module-scoped marker and the space that preceded it", () => {
    expect(stripLeakedSourceIds("Batches run nightly [facts:docker_oracle_init:1].")).toBe(
      "Batches run nightly.",
    );
  });

  it("removes the #1354 repository-scoped marker, percent-encoding and all", () => {
    const encoded =
      "[facts:repo:%5B%22cmsfck5lq000cfhwhrxkvlrjp%22%2C%22cmsfck81r000ffhwhz12qwvwr%22%2C%22components%2Forder-batch-war%22%5D:3]";
    const out = stripLeakedSourceIds(`The war module owns invoicing ${encoded}.`);
    expect(out).toBe("The war module owns invoicing.");
    expect(out).not.toContain("%");
  });

  it("removes typed-symbol markers (#1354 symbol form)", () => {
    const marker = "[facts:symbol:repo%3A%255B%2522repo-a%2522%255D:sym-a:20-23]";
    expect(stripLeakedSourceIds(`OrderService validates totals ${marker}.`)).toBe(
      "OrderService validates totals.",
    );
  });

  it("removes several markers in one sentence", () => {
    expect(
      stripLeakedSourceIds("Rules apply [facts:a:0] and totals are derived [facts:b:1]."),
    ).toBe("Rules apply and totals are derived.");
  });

  it("leaves ordinary markdown links untouched", () => {
    const md = "See [the runbook](https://example.invalid/runbook) and [notes][ref].";
    expect(stripLeakedSourceIds(md)).toBe(md);
  });

  it("does not touch content inside fenced code blocks", () => {
    const md = ["Prose [facts:a:0].", "", "```ts", 'const id = "[facts:a:0]";', "```"].join("\n");
    expect(stripLeakedSourceIds(md)).toBe(
      ["Prose.", "", "```ts", 'const id = "[facts:a:0]";', "```"].join("\n"),
    );
  });

  it("preserves table alignment and indented code — no whitespace normalisation", () => {
    const md = [
      "| Module | Purpose  |",
      "|--------|----------|",
      "| orders | Billing  [facts:a:0] |",
      "",
      "    indented code stays indented",
    ].join("\n");
    // Only ONE space is consumed with the marker; the column's original padding
    // survives. Collapsing it would be exactly the normalisation this forbids.
    expect(stripLeakedSourceIds(md)).toBe(
      [
        "| Module | Purpose  |",
        "|--------|----------|",
        "| orders | Billing  |",
        "",
        "    indented code stays indented",
      ].join("\n"),
    );
  });

  it("does not span lines or swallow a following bracket", () => {
    const md = "Alpha [facts:a:0]\nBeta [kept] gamma.";
    expect(stripLeakedSourceIds(md)).toBe("Alpha\nBeta [kept] gamma.");
  });

  it("is idempotent", () => {
    const once = stripLeakedSourceIds("Rules apply [facts:a:0].");
    expect(stripLeakedSourceIds(once)).toBe(once);
  });

  /**
   * The model truncates its own output, so a marker can end at a line break
   * with no `]` at all. Three such markers survived the first #1370 pass and
   * rendered verbatim in prose AND in Markdown export.
   */
  describe("unterminated markers", () => {
    it("strips a legacy marker cut off at a line break", () => {
      expect(
        stripLeakedSourceIds("Bootstraps the context [facts:src_RCE_AddEndPoint:1\n## Next"),
      ).toBe("Bootstraps the context\n## Next");
    });

    it("strips an unterminated rag marker", () => {
      expect(
        stripLeakedSourceIds("Loaded on startup [rag:cmqhu8aca02eu2lwh2s8v0ilk:\n## Next"),
      ).toBe("Loaded on startup\n## Next");
    });

    it("strips a repo identity truncated mid percent-encoding", () => {
      const out = stripLeakedSourceIds(
        "under key applicationContext [facts:repo:%5B%22cmsfck5lq000cfhwhrxkvlrjp%22%2C%22components%2Forder-batch\n## Cross-Cutting",
      );
      expect(out).toBe("under key applicationContext\n## Cross-Cutting");
      expect(out).not.toContain("%");
    });

    it("does not swallow the rest of the document", () => {
      const out = stripLeakedSourceIds("Alpha [facts:a:0\nBeta stays.\nGamma stays.");
      expect(out).toBe("Alpha\nBeta stays.\nGamma stays.");
    });

    it("still leaves ordinary bracketed text alone", () => {
      const md = "A [normal] bracket and [a link](https://example.invalid).";
      expect(stripLeakedSourceIds(md)).toBe(md);
    });
  });

  it("leaves a document with no markers byte-identical", () => {
    const md = "# Title\n\nNothing to strip here.\n";
    expect(stripLeakedSourceIds(md)).toBe(md);
  });
});
