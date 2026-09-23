/**
 * #98 — an indexing failure's `errorMessage` reaches a client only as one of a
 * fixed set of user-safe strings, never the raw exception text the ingest
 * pipeline wrote to `Document.errorMessage`.
 */
import { describe, expect, it } from "vitest";
import {
  INDEXING_CONTENT_MISMATCH_MESSAGE,
  INDEXING_EMBEDDER_UNAVAILABLE_MESSAGE,
  INDEXING_EMPTY_TEXT_MESSAGE,
  INDEXING_FAILED_MESSAGE,
  INDEXING_FILE_TOO_LARGE_MESSAGE,
  INDEXING_PARSE_FAILED_MESSAGE,
  INDEXING_PROVIDER_AUTH_MESSAGE,
  INDEXING_PROVIDER_RATE_LIMITED_MESSAGE,
  INDEXING_PROVIDER_UNREACHABLE_MESSAGE,
  INDEXING_REJECTED_MESSAGE,
  INDEXING_STORAGE_MESSAGE,
  INDEXING_TOO_MANY_PAGES_MESSAGE,
  INDEXING_UNSUPPORTED_TYPE_MESSAGE,
  indexingFailureMessage,
  publicIndexingErrorMessage,
} from "./indexing-failure-message.js";

/** A provider response body with an absolute path and an API-key-shaped string. */
const RAW_PROVIDER_BODY =
  'embedding failed: embeddings returned 500: {"error":{"message":"upstream failure ' +
  'reading /srv/metis/server/data/uploads/acme/secret.pdf","key":"sk-live-4f9a8b7c6d5e4f3a2b1c"}}' +
  "\n    at OpenAICompatibleProvider.embed (/srv/metis/server/src/lib/ai/providers/x.ts:12:7)";

function expectNoLeak(msg: string | null) {
  expect(msg).not.toBeNull();
  expect(msg).not.toContain("/srv");
  expect(msg).not.toContain("sk-live");
  expect(msg).not.toContain("secret.pdf");
  expect(msg).not.toMatch(/\bat \w+\./);
}

describe("indexingFailureMessage", () => {
  it("never echoes a provider response body, path, key or stack", () => {
    const msg = indexingFailureMessage(RAW_PROVIDER_BODY);
    expectNoLeak(msg);
    // It was an embedding failure, and that much is still said.
    expect(msg).toBe(INDEXING_EMBEDDER_UNAVAILABLE_MESSAGE);
  });

  it("collapses an unrecognised error to the generic message", () => {
    expect(indexingFailureMessage(new Error("SQLITE_BUSY: database is locked at /srv/x"))).toBe(
      INDEXING_FAILED_MESSAGE,
    );
    expect(indexingFailureMessage("auto-approve failed: Error: boom /srv/metis")).toBe(
      INDEXING_FAILED_MESSAGE,
    );
    expect(indexingFailureMessage(undefined)).toBe(INDEXING_FAILED_MESSAGE);
    expect(indexingFailureMessage({ weird: true })).toBe(INDEXING_FAILED_MESSAGE);
  });

  it("names an unreachable embedding host — the local-Ollama-down case", () => {
    const refused = new TypeError("fetch failed", {
      cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:11434"), {
        code: "ECONNREFUSED",
      }),
    });
    expect(indexingFailureMessage(refused)).toBe(INDEXING_PROVIDER_UNREACHABLE_MESSAGE);
    // As knowledge-service stores it: prefixed, cause lost, words kept.
    const stored = "embedding failed: fetch failed";
    expect(indexingFailureMessage(stored)).toBe(INDEXING_PROVIDER_UNREACHABLE_MESSAGE);
    expect(indexingFailureMessage("embedding failed: connect ECONNREFUSED 10.0.0.5:11434")).toBe(
      INDEXING_PROVIDER_UNREACHABLE_MESSAGE,
    );
    expect(INDEXING_PROVIDER_UNREACHABLE_MESSAGE).not.toContain("10.0.0.5");
  });

  it("recognises rejected credentials and rate limiting", () => {
    expect(indexingFailureMessage("embedding failed: embeddings returned 401: {...}")).toBe(
      INDEXING_PROVIDER_AUTH_MESSAGE,
    );
    expect(indexingFailureMessage("embedding failed: Incorrect API key provided: sk-abc")).toBe(
      INDEXING_PROVIDER_AUTH_MESSAGE,
    );
    expect(indexingFailureMessage("embedding failed: embeddings returned 429: slow down")).toBe(
      INDEXING_PROVIDER_RATE_LIMITED_MESSAGE,
    );
  });

  it("classifies a METIS embedder shape mismatch as embedder unavailable", () => {
    expect(indexingFailureMessage("embedder returned 3 vectors for 4 chunks")).toBe(
      INDEXING_EMBEDDER_UNAVAILABLE_MESSAGE,
    );
  });

  it("maps every parser refusal code to its own fixed message", () => {
    expect(indexingFailureMessage("MIME_UNSUPPORTED")).toBe(INDEXING_UNSUPPORTED_TYPE_MESSAGE);
    expect(
      indexingFailureMessage("CONTENT_TYPE_MISMATCH: declared application/pdf, content text/x"),
    ).toBe(INDEXING_CONTENT_MISMATCH_MESSAGE);
    expect(indexingFailureMessage("PARSER_FILE_TOO_LARGE")).toBe(INDEXING_FILE_TOO_LARGE_MESSAGE);
    expect(indexingFailureMessage("PDF_TOO_MANY_PAGES")).toBe(INDEXING_TOO_MANY_PAGES_MESSAGE);
    expect(indexingFailureMessage("PDF_EMPTY_TEXT")).toBe(INDEXING_EMPTY_TEXT_MESSAGE);
    expect(indexingFailureMessage("DOCX_EMPTY_TEXT")).toBe(INDEXING_EMPTY_TEXT_MESSAGE);
    for (const kind of ["PDF", "DOCX", "XLSX", "PPTX"]) {
      const msg = indexingFailureMessage(`${kind}_PARSE_FAILED: Error: bad xref at /srv/x.pdf`);
      expect(msg).toBe(INDEXING_PARSE_FAILED_MESSAGE);
      expect(msg).not.toContain("/srv");
    }
  });

  it("does not read a parser code in the middle of an exception as a refusal", () => {
    expect(indexingFailureMessage("Error: saw MIME_UNSUPPORTED at /srv/x")).toBe(
      INDEXING_FAILED_MESSAGE,
    );
  });

  it("names a storage read failure without the storage error", () => {
    const msg = indexingFailureMessage(
      "storage read failed: ENOENT: no such file, open '/srv/metis/uploads/a.pdf'",
    );
    expect(msg).toBe(INDEXING_STORAGE_MESSAGE);
    expect(msg).not.toContain("/srv");
  });

  it("passes its own vocabulary through unchanged", () => {
    for (const safe of [
      INDEXING_FAILED_MESSAGE,
      INDEXING_EMBEDDER_UNAVAILABLE_MESSAGE,
      INDEXING_PROVIDER_UNREACHABLE_MESSAGE,
      INDEXING_PROVIDER_AUTH_MESSAGE,
      INDEXING_PROVIDER_RATE_LIMITED_MESSAGE,
      INDEXING_STORAGE_MESSAGE,
      INDEXING_REJECTED_MESSAGE,
      INDEXING_UNSUPPORTED_TYPE_MESSAGE,
      INDEXING_CONTENT_MISMATCH_MESSAGE,
      INDEXING_FILE_TOO_LARGE_MESSAGE,
      INDEXING_TOO_MANY_PAGES_MESSAGE,
      INDEXING_EMPTY_TEXT_MESSAGE,
      INDEXING_PARSE_FAILED_MESSAGE,
    ]) {
      expect(indexingFailureMessage(safe)).toBe(safe);
    }
  });
});

describe("publicIndexingErrorMessage", () => {
  it("returns null for no message", () => {
    expect(publicIndexingErrorMessage(null)).toBeNull();
    expect(publicIndexingErrorMessage(undefined)).toBeNull();
  });

  it("sanitises the raw text an old row already holds, whatever its state", () => {
    for (const state of [undefined, "pending", "reconciling", "indexed", "rejected"]) {
      expectNoLeak(publicIndexingErrorMessage(RAW_PROVIDER_BODY, state));
    }
  });

  it("shows a fixed rejection message for a rejected row, never the stored text", () => {
    expect(publicIndexingErrorMessage("rejected", "rejected")).toBe(INDEXING_REJECTED_MESSAGE);
    // A rejected row can still be overwritten by the ingest queue's fallthrough
    // write, so the stored text is not trusted to be the reviewer's reason.
    expect(publicIndexingErrorMessage("Error: SQLITE_BUSY at /srv/db", "rejected")).toBe(
      INDEXING_REJECTED_MESSAGE,
    );
  });

  it("keeps the METIS-authored deletion marker", () => {
    expect(publicIndexingErrorMessage("deleted", "pending")).toBe("deleted");
  });
});
