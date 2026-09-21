/**
 * Epic #726 (#734) — the finding citation union. Locks two guarantees:
 *   1. every pre-#734 DOCUMENT citation still validates byte-identically
 *      (backward compatibility — persisted findings must keep parsing);
 *   2. the new CODE citation shape validates, and the type guards / locator
 *      helper discriminate the two so server + UI never drift.
 */
import { describe, expect, it } from "vitest";
import {
  citationSchema,
  codeCitationSchema,
  documentCitationSchema,
  formatCodeCitationLocator,
  isCodeCitation,
  isDocumentCitation,
  type Citation,
} from "./analysis.js";

describe("citation union", () => {
  it("validates a legacy document citation unchanged", () => {
    const doc = {
      documentId: "clabc123456",
      chunkIndex: 3,
      filename: "spec.md",
      snippet: "the system shall...",
      score: 0.8,
    };
    const parsed = citationSchema.parse(doc);
    expect(parsed).toEqual(doc);
    expect(isDocumentCitation(parsed)).toBe(true);
    expect(isCodeCitation(parsed)).toBe(false);
  });

  it("validates a minimal document citation (no optional fields)", () => {
    const parsed = citationSchema.parse({ documentId: "clabc123456", chunkIndex: 0 });
    expect(isDocumentCitation(parsed)).toBe(true);
  });

  it("accepts an over-long code-graph: documentId so a long symbol name never discards a finding", () => {
    // A qualified-name symbolId can push `code-graph:<id>` well past idSchema's
    // 64-char cap; it must still validate (it is normalised to a code citation
    // downstream) rather than fail the whole finding at agentOutputSchema.parse.
    const longId = `code-graph:${"com.example.deeply.nested.Service.methodWithAVeryLongQualifiedName".repeat(2)}`;
    expect(longId.length).toBeGreaterThan(64);
    const parsed = citationSchema.parse({ documentId: longId, chunkIndex: 0 });
    expect(isDocumentCitation(parsed)).toBe(true);
  });

  it("still rejects a non-code-graph documentId longer than 64 chars", () => {
    expect(() => citationSchema.parse({ documentId: "x".repeat(65), chunkIndex: 0 })).toThrow();
  });

  it("validates a code citation", () => {
    const code = {
      filePath: "server/src/lib/auth/session.ts",
      startLine: 10,
      endLine: 42,
      symbolId: "sym-123",
      snippet: "export function createSession()",
    };
    const parsed = citationSchema.parse(code);
    expect(parsed).toEqual(code);
    expect(isCodeCitation(parsed)).toBe(true);
    expect(isDocumentCitation(parsed)).toBe(false);
  });

  it("rejects a code citation missing line numbers", () => {
    expect(() => codeCitationSchema.parse({ filePath: "a.ts", startLine: 1 } as unknown)).toThrow();
  });

  it("rejects a citation that is neither a document nor a code citation", () => {
    expect(() => citationSchema.parse({ snippet: "orphan" } as unknown)).toThrow();
  });

  it("rejects line numbers below 1", () => {
    expect(() =>
      codeCitationSchema.parse({ filePath: "a.ts", startLine: 0, endLine: 5 }),
    ).toThrow();
  });

  it("formats the canonical filePath:startLine-endLine locator", () => {
    expect(formatCodeCitationLocator({ filePath: "a/b.ts", startLine: 3, endLine: 9 })).toBe(
      "a/b.ts:3-9",
    );
  });

  it("keeps document-citation fields the same as the document schema", () => {
    const doc: Citation = { documentId: "clabc123456", chunkIndex: 1 };
    expect(documentCitationSchema.safeParse(doc).success).toBe(true);
  });
});
