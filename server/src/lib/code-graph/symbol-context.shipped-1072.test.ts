/**
 * Issue #1072 — the documents PRODUCTION builds from the context fields: which
 * fields they carry, and that they are the documents ADR 0020 measured.
 */
import { describe, it, expect } from "vitest";
import {
  bodySnippet,
  composeEmbeddingText,
  contextLines,
  contextualDocumentText,
  extractOwnFileContext,
  NO_OWN_CONTEXT,
  receiverOf,
  shippedContextLines,
  shippedDocumentText,
} from "./symbol-context.js";
import { formatSymbolForEmbedding } from "./symbol-embeddings.js";

describe("a file's module symbol has no own-file context", () => {
  it("returns nothing for kind module, whatever the file says", () => {
    const lines = ["// A header comment.", "package storage", "", "func Save() {", "}"];
    expect(
      extractOwnFileContext(
        { kind: "module", qualifiedName: "internal/storage/user.go", startLine: 1, endLine: 5 },
        { filePath: "internal/storage/user.go", language: "go", package: "storage" },
        lines,
      ),
    ).toEqual({ signature: null, docComment: null, receiver: null, package: null });
  });

  it("NO_OWN_CONTEXT cannot be changed by a caller", () => {
    expect(Object.isFrozen(NO_OWN_CONTEXT)).toBe(true);
    expect(shippedContextLines(NO_OWN_CONTEXT)).toBe("");
  });
});

describe("receiverOf", () => {
  it("reads the receiver off a renamed Go qualified name", () => {
    expect(
      receiverOf({ kind: "function", qualifiedName: "a/b.go::Storage::Save" }, "a/b.go", "go"),
    ).toBe("Storage");
    expect(receiverOf({ kind: "function", qualifiedName: "a/b.go::Save" }, "a/b.go", "go")).toBe(
      null,
    );
  });

  it("is null for a module even in Go", () => {
    expect(
      receiverOf({ kind: "module", qualifiedName: "a/b.go::x::y" }, "a/b.go", "go"),
    ).toBeNull();
  });
});

describe("the documents production builds", () => {
  const sym = {
    name: "Save",
    qualifiedName: "internal/storage/user.go::Storage::Save",
    signature: "func (s *Storage) Save(u *User) error",
    docstring: "Save stores the user.",
    receiver: "Storage",
    package: "storage",
    callers: ["createUser"],
    tables: ["users"],
  };

  it("BM25: name, qualified name, package, signature, doc comment — in that order", () => {
    expect(shippedDocumentText(sym)).toBe(
      "Save internal/storage/user.go::Storage::Save storage " +
        "func (s *Storage) Save(u *User) error Save stores the user.",
    );
  });

  it("BM25: is the measured own-file document minus the receiver", () => {
    const { receiver: _receiver, ...withoutReceiver } = sym;
    expect(shippedDocumentText(sym)).toBe(contextualDocumentText(withoutReceiver, "own"));
    expect(shippedDocumentText(sym)).not.toBe(contextualDocumentText(sym, "own"));
  });

  it("BM25: a symbol with no context field is name and qualified name", () => {
    expect(shippedDocumentText({ name: "users", qualifiedName: "public.users" })).toBe(
      "users public.users",
    );
  });

  it("embedding: a package line and a doc line, and never a receiver line", () => {
    expect(shippedContextLines({ package: "storage", docComment: "Save stores the user." })).toBe(
      "package: storage\ndoc: Save stores the user.",
    );
    expect(shippedContextLines({ package: null, docComment: "D" })).toBe("doc: D");
    expect(shippedContextLines({ package: "p", docComment: null })).toBe("package: p");
    expect(shippedContextLines({ package: "p", docComment: null, receiver: "R" } as never)).toBe(
      "package: p",
    );
  });

  it("embedding: is the measured own-file lines when there is no receiver", () => {
    const own = { receiver: null, package: "storage", docComment: "Save stores the user." };
    expect(shippedContextLines(own)).toBe(contextLines(own));
  });
});

describe("formatSymbolForEmbedding places the context lines as the measured text does", () => {
  const base = {
    symbolId: "s",
    name: "saveUser",
    qualifiedName: "store/users.ts::saveUser",
    kind: "function" as const,
    filePath: "store/users.ts",
    bodyLines: ["export function saveUser(user: User): void {", "  write(user);", "}"],
  };

  it("header, context lines, then the body", () => {
    expect(
      formatSymbolForEmbedding({ ...base, contextLines: "package: store\ndoc: Persists." }),
    ).toBe(
      [
        "function saveUser in store/users.ts",
        "package: store",
        "doc: Persists.",
        "export function saveUser(user: User): void {",
        "  write(user);",
        "}",
      ].join("\n"),
    );
  });

  it("equals composeEmbeddingText over the text main built, so ingest writes what was scored", () => {
    const context = "package: store\ndoc: Persists.";
    expect(formatSymbolForEmbedding({ ...base, contextLines: context })).toBe(
      composeEmbeddingText(formatSymbolForEmbedding(base), context),
    );
  });

  it("is unchanged when there are no context lines", () => {
    expect(formatSymbolForEmbedding({ ...base, contextLines: "" })).toBe(
      formatSymbolForEmbedding(base),
    );
  });

  it("replays a stored text verbatim, ignoring context lines", () => {
    expect(formatSymbolForEmbedding({ ...base, text: "stored", contextLines: "doc: X" })).toBe(
      "stored",
    );
  });
});

describe("bodySnippet skips the context lines of a stored text", () => {
  const context = "package: store\ndoc: Persists.";
  const text = `function f in store/f.ts\n${context}\nfunction f() {\n  return 1;\n}`;

  it("starts at the first body line", () => {
    expect(bodySnippet(text, context)).toBe("function f() {\n  return 1;\n}");
  });

  it("keeps the context lines when it is not told what they are", () => {
    expect(bodySnippet(text)).toBe(`${context}\nfunction f() {\n  return 1;\n}`);
    expect(bodySnippet(text, "")).toBe(bodySnippet(text));
    expect(bodySnippet(text, null)).toBe(bodySnippet(text));
  });

  it("does not skip a body line that only begins like the context", () => {
    // An old-format text whose first body line happens to start with the same words.
    const old = "function f in store/f.ts\npackage: storefront()\nmore";
    expect(bodySnippet(old, "package: store")).toBe("package: storefront()\nmore");
  });

  it("does not skip when the stored context differs", () => {
    expect(bodySnippet(text, "package: other")).toBe(bodySnippet(text));
  });

  it("is undefined for a text that is a header and context lines only", () => {
    expect(bodySnippet(`function f in store/f.ts\n${context}`, context)).toBeUndefined();
  });
});
