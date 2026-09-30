/** #547 — a stored `documents.source` narrows to the closed set, failing closed. */
import { describe, expect, it } from "vitest";
import { DOCUMENT_SOURCES } from "@metis/shared";
import { asDocumentSource } from "./document-source.js";

describe("asDocumentSource", () => {
  it("keeps every known source", () => {
    for (const s of DOCUMENT_SOURCES) expect(asDocumentSource(s)).toBe(s);
  });

  it("reads an unrecognised value as an upload, never a connector", () => {
    expect(asDocumentSource("connector")).toBe("upload");
    expect(asDocumentSource("REPO")).toBe("upload");
    expect(asDocumentSource("")).toBe("upload");
  });
});
