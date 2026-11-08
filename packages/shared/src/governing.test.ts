import { describe, expect, it } from "vitest";
import {
  GOVERNING_EXTRACTION_STATES,
  GOVERNING_RULE_EDIT_KINDS,
  governingDocumentRevisionSchema,
  governingDocumentSchema,
  governingRuleEditSchema,
  governingRuleSchema,
} from "./governing.js";
import { DOCUMENT_INDEX_STATES } from "./rag-hardening.js";

const at = "2026-11-06T12:00:00.000Z";

const document = {
  id: "gd-1",
  workspaceId: "ws-1",
  title: "Information security policy",
  framework: "Internal security policy",
  currentRevisionId: "gr-1",
  createdById: "u-1",
  createdAt: at,
  deletedAt: null,
};

const revision = {
  id: "gr-1",
  documentId: "gd-1",
  revisionLabel: "v3",
  effectiveDate: "2026-10-01T00:00:00.000Z",
  contentHash: "a".repeat(64),
  mimeType: "text/markdown",
  sizeBytes: 2048,
  indexState: "indexed",
  extractionState: "done",
  extractionError: null,
  extractionStartedAt: at,
  droppedUnverified: 0,
  uploadedById: "u-1",
  createdAt: at,
};

const rule = {
  id: "rule-1",
  revisionId: "gr-1",
  controlId: "AC-2",
  summary: "Review user access every quarter.",
  clauseRef: "§4.3",
  clauseStart: 120,
  clauseEnd: 180,
  clauseExcerpt: "Access rights are reviewed at least once every quarter.",
  category: "access-control",
  editedById: null,
  editedAt: null,
  deletedAt: null,
  createdAt: at,
};

describe("governing document wire schemas (#1868)", () => {
  it("names the extraction lifecycle and edit kinds", () => {
    expect(GOVERNING_EXTRACTION_STATES).toEqual(["pending", "running", "done", "failed"]);
    expect(GOVERNING_RULE_EDIT_KINDS).toEqual(["edit", "delete"]);
  });

  it("parses a document, a revision, a rule and an edit", () => {
    expect(governingDocumentSchema.parse(document)).toEqual(document);
    expect(governingDocumentRevisionSchema.parse(revision)).toEqual(revision);
    expect(governingRuleSchema.parse(rule)).toEqual(rule);
    const edit = {
      id: "e-1",
      ruleId: "rule-1",
      kind: "edit",
      editedById: "u-2",
      before: { summary: "Review access." },
      after: { summary: "Review user access every quarter." },
      createdAt: at,
    };
    expect(governingRuleEditSchema.parse(edit)).toEqual(edit);
  });

  it("takes a revision's index state from the document quarantine lifecycle", () => {
    for (const indexState of DOCUMENT_INDEX_STATES) {
      expect(governingDocumentRevisionSchema.safeParse({ ...revision, indexState }).success).toBe(
        true,
      );
    }
    expect(
      governingDocumentRevisionSchema.safeParse({ ...revision, indexState: "ready" }).success,
    ).toBe(false);
  });

  it("never carries a revision's storage path or its full text", () => {
    const parsed = governingDocumentRevisionSchema.parse({
      ...revision,
      storagePath: "/var/metis/governing/ws-1/gd-1/v3.md",
      extractedText: "the whole policy",
    });
    expect(parsed).not.toHaveProperty("storagePath");
    expect(parsed).not.toHaveProperty("extractedText");
  });

  it.each([
    ["an empty title", governingDocumentSchema, { ...document, title: "" }],
    ["a missing workspace", governingDocumentSchema, { ...document, workspaceId: "" }],
    ["a date that is not ISO", governingDocumentSchema, { ...document, createdAt: "yesterday" }],
    [
      "an unknown extraction state",
      governingDocumentRevisionSchema,
      { ...revision, extractionState: "queued" },
    ],
    ["a negative size", governingDocumentRevisionSchema, { ...revision, sizeBytes: -1 }],
    [
      "a negative dropped-rule count",
      governingDocumentRevisionSchema,
      { ...revision, droppedUnverified: -1 },
    ],
    [
      "an extraction error past the cap",
      governingDocumentRevisionSchema,
      { ...revision, extractionError: "x".repeat(501) },
    ],
    [
      "an empty revision label",
      governingDocumentRevisionSchema,
      { ...revision, revisionLabel: "" },
    ],
    ["a negative clause start", governingRuleSchema, { ...rule, clauseStart: -1 }],
    ["a clause that ends where it starts", governingRuleSchema, { ...rule, clauseEnd: 120 }],
    ["a clause that ends before it starts", governingRuleSchema, { ...rule, clauseEnd: 100 }],
    ["a fractional offset", governingRuleSchema, { ...rule, clauseEnd: 180.5 }],
    ["an empty summary", governingRuleSchema, { ...rule, summary: "" }],
    ["an empty control id", governingRuleSchema, { ...rule, controlId: "" }],
  ])("refuses %s", (_name, schema, value) => {
    expect(schema.safeParse(value).success).toBe(false);
  });

  it("refuses an unknown edit kind", () => {
    expect(
      governingRuleEditSchema.safeParse({
        id: "e-1",
        ruleId: "rule-1",
        kind: "restore",
        editedById: "u-2",
        before: {},
        after: {},
        createdAt: at,
      }).success,
    ).toBe(false);
  });
});
