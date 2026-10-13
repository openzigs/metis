/**
 * Issue #1072 — the production searcher reads the context columns into the
 * BM25 document, and a fused hit carries a bounded body snippet.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const findMany = vi.hoisted(() => vi.fn());
const aggregate = vi.hoisted(() => vi.fn());
const graphAggregate = vi.hoisted(() => vi.fn());
const embeddingFindMany = vi.hoisted(() => vi.fn());

vi.mock("../prisma.js", () => ({
  prisma: {
    codeSymbol: { findMany, aggregate },
    codeGraph: { aggregate: graphAggregate },
    codeSymbolEmbedding: { findMany: embeddingFindMany },
  },
}));

import { buildSymbolDocumentText } from "./hybrid-search.js";
import {
  __resetSymbolIndexCache,
  createDefaultCodeSearcher,
  createDefaultSnippetLookup,
  createRunScopedSymbolIndex,
  prismaSymbolIndex,
} from "./project-code-searcher.js";

beforeEach(() => {
  aggregate.mockResolvedValue({ _count: { _all: 2 }, _max: { createdAt: new Date(1_000) } });
  graphAggregate.mockResolvedValue({ _max: { lastIndexedAt: new Date(5_000) } });
});

afterEach(() => {
  findMany.mockReset();
  aggregate.mockReset();
  graphAggregate.mockReset();
  embeddingFindMany.mockReset();
  __resetSymbolIndexCache();
  vi.restoreAllMocks();
});

const ROWS = [
  {
    id: "s-save",
    name: "saveUser",
    qualifiedName: "store/users.ts::saveUser",
    kind: "function",
    filePath: "store/users.ts",
    signature: "export function saveUser(user: User): void",
    docComment: "Persists a member so that later logins find the account.",
    package: "store",
  },
  {
    id: "s-table",
    name: "public.users",
    qualifiedName: "public.users",
    kind: "table",
    filePath: "schema.prisma",
    signature: null,
    docComment: null,
    package: null,
  },
];

/** BM25-only: the vector channel returns nothing. */
const lexicalDeps = {
  vectorStore: { search: async () => [] },
  embedService: { embed: async () => ({ vectors: [], dimension: 0, model: "none" }) },
};

describe("#1072 — the symbol index reads the context columns", () => {
  it("selects signature, docComment and package, and not receiver", async () => {
    findMany.mockResolvedValue(ROWS);
    await prismaSymbolIndex.getSymbols("p1");
    expect(findMany.mock.calls[0][0].select).toEqual({
      id: true,
      name: true,
      qualifiedName: true,
      kind: true,
      filePath: true,
      signature: true,
      docComment: true,
      package: true,
    });
  });

  it("maps the columns onto the searchable symbol, and leaves absent ones off it", async () => {
    findMany.mockResolvedValue(ROWS);
    const [save, table] = await prismaSymbolIndex.getSymbols("p1");
    expect(save).toEqual({
      symbolId: "s-save",
      name: "saveUser",
      qualifiedName: "store/users.ts::saveUser",
      kind: "function",
      filePath: "store/users.ts",
      signature: "export function saveUser(user: User): void",
      docstring: "Persists a member so that later logins find the account.",
      package: "store",
    });
    expect(table).toEqual({
      symbolId: "s-table",
      name: "public.users",
      qualifiedName: "public.users",
      kind: "table",
      filePath: "schema.prisma",
    });
  });

  it("builds the BM25 document from them; a symbol without any keeps the old document", async () => {
    findMany.mockResolvedValue(ROWS);
    const [save, table] = await prismaSymbolIndex.getSymbols("p1");
    expect(buildSymbolDocumentText(save)).toBe(
      "saveUser store/users.ts::saveUser store export function saveUser(user: User): void " +
        "Persists a member so that later logins find the account.",
    );
    expect(buildSymbolDocumentText(table)).toBe("public.users public.users");
  });

  it("the run-scoped index and the hydration path read the same columns", async () => {
    const client = { codeSymbol: { findMany: vi.fn().mockResolvedValue(ROWS) } };
    const index = createRunScopedSymbolIndex(client as never);
    const all = await index.getSymbols("p1");
    expect(all[0].docstring).toBe("Persists a member so that later logins find the account.");
    const some = await index.getSymbolsByIds?.("p1", ["s-save"]);
    expect(some?.[0].package).toBe("store");
    expect(client.codeSymbol.findMany.mock.calls[1][0].select.docComment).toBe(true);

    findMany.mockResolvedValue([ROWS[0]]);
    const hydrated = await prismaSymbolIndex.getSymbolsByIds?.("p1", ["s-save"]);
    expect(hydrated?.[0].signature).toBe("export function saveUser(user: User): void");
  });

  it("finds a symbol by a word only its doc comment carries", async () => {
    findMany.mockResolvedValue(ROWS);
    embeddingFindMany.mockResolvedValue([]);
    const hits = await createDefaultCodeSearcher(lexicalDeps as never).search("later logins", "p1");
    expect(hits.map((h) => h.symbolId)).toEqual(["s-save"]);
  });

  it("does not put the receiver, callers or tables in the document", () => {
    expect(
      buildSymbolDocumentText({
        symbolId: "x",
        name: "Save",
        qualifiedName: "a.go::Storage::Save",
        kind: "function",
        filePath: "a.go",
        receiver: "Storage",
        callers: ["createUser"],
        tables: ["users"],
      }),
    ).toBe("Save a.go::Storage::Save");
  });
});

describe("#1072 — a fused hit carries a bounded body snippet", () => {
  const TEXT = [
    "function saveUser in store/users.ts",
    "package: store",
    "doc: Persists a member so that later logins find the account.",
    "export function saveUser(user: User): void {",
    "  write(user);",
    "}",
  ].join("\n");
  const embeddingRow = {
    symbolId: "s-save",
    text: TEXT,
    symbol: {
      package: "store",
      docComment: "Persists a member so that later logins find the account.",
    },
  };

  it("cuts the snippet from the stored text, after the header and the context lines", async () => {
    findMany.mockResolvedValue(ROWS);
    embeddingFindMany.mockResolvedValue([embeddingRow]);
    const hits = await createDefaultCodeSearcher(lexicalDeps as never).search("saveUser", "p1");
    expect(hits[0].snippet).toBe("export function saveUser(user: User): void {\n  write(user);\n}");
    expect(embeddingFindMany).toHaveBeenCalledWith({
      where: { projectId: "p1", symbolId: { in: ["s-save"] } },
      select: {
        symbolId: true,
        text: true,
        symbol: { select: { package: true, docComment: true } },
      },
    });
  });

  it("reads snippets only for the hits it returns", async () => {
    findMany.mockResolvedValue(ROWS);
    embeddingFindMany.mockResolvedValue([]);
    await createDefaultCodeSearcher(lexicalDeps as never).search("users", "p1", { limit: 1 });
    expect(embeddingFindMany.mock.calls[0][0].where.symbolId.in).toHaveLength(1);
  });

  it("keeps the signature for a hit with no stored text", async () => {
    findMany.mockResolvedValue(ROWS);
    embeddingFindMany.mockResolvedValue([]);
    const hits = await createDefaultCodeSearcher(lexicalDeps as never).search("saveUser", "p1");
    expect(hits[0].snippet).toBe("export function saveUser(user: User): void");
  });

  it("still returns the hits when the snippet read fails", async () => {
    findMany.mockResolvedValue(ROWS);
    embeddingFindMany.mockRejectedValue(new Error("db gone"));
    const hits = await createDefaultCodeSearcher(lexicalDeps as never).search("saveUser", "p1");
    expect(hits.map((h) => h.symbolId)).toEqual(["s-save"]);
    expect(hits[0].snippet).toBe("export function saveUser(user: User): void");
  });

  it("does not read snippets when nothing matched", async () => {
    findMany.mockResolvedValue(ROWS);
    const hits = await createDefaultCodeSearcher(lexicalDeps as never).search("zzzz", "p1");
    expect(hits).toEqual([]);
    expect(embeddingFindMany).not.toHaveBeenCalled();
  });

  it("uses no default lookup behind an injected symbol index", async () => {
    const symbolIndex = {
      getSymbols: async () => [
        { symbolId: "c1", name: "saveUser", qualifiedName: "q", kind: "function", filePath: "f" },
      ],
    };
    const hits = await createDefaultCodeSearcher({ ...lexicalDeps, symbolIndex } as never).search(
      "saveUser",
      "p1",
    );
    expect(hits).toHaveLength(1);
    expect(hits[0].snippet).toBeUndefined();
    expect(embeddingFindMany).not.toHaveBeenCalled();
  });

  it("uses an injected lookup, and none when it is null", async () => {
    findMany.mockResolvedValue(ROWS);
    const resolve = vi.fn().mockResolvedValue(new Map([["s-save", "BODY"]]));
    const withLookup = createDefaultCodeSearcher({
      ...lexicalDeps,
      snippetLookup: { resolve },
    } as never);
    expect((await withLookup.search("saveUser", "p1"))[0].snippet).toBe("BODY");
    expect(resolve).toHaveBeenCalledWith(["s-save"], "p1");

    const off = createDefaultCodeSearcher({ ...lexicalDeps, snippetLookup: null } as never);
    expect((await off.search("saveUser", "p1"))[0].snippet).toBe(
      "export function saveUser(user: User): void",
    );
    expect(embeddingFindMany).not.toHaveBeenCalled();
  });
});

describe("createDefaultSnippetLookup", () => {
  it("short-circuits on an empty id list without querying", async () => {
    const client = { codeSymbolEmbedding: { findMany: vi.fn() } };
    const map = await createDefaultSnippetLookup(client as never).resolve([], "p1");
    expect(map.size).toBe(0);
    expect(client.codeSymbolEmbedding.findMany).not.toHaveBeenCalled();
  });

  it("leaves out a symbol whose text has no body", async () => {
    const client = {
      codeSymbolEmbedding: {
        findMany: vi.fn().mockResolvedValue([
          {
            symbolId: "a",
            text: "function a in a.ts",
            symbol: { package: null, docComment: null },
          },
          {
            symbolId: "b",
            text: "function b in b.ts\nfunction b() {}",
            symbol: { package: null, docComment: null },
          },
        ]),
      },
    };
    const map = await createDefaultSnippetLookup(client as never).resolve(["a", "b"], "p1");
    expect([...map.entries()]).toEqual([["b", "function b() {}"]]);
  });

  it("reads a text written before #1072, which has no context lines, from its first body line", async () => {
    const client = {
      codeSymbolEmbedding: {
        findMany: vi.fn().mockResolvedValue([
          {
            symbolId: "a",
            // The columns are filled in but the text is still the old shape.
            text: "function a in pkg/a.ts\nfunction a() {}",
            symbol: { package: "pkg", docComment: "Does a." },
          },
        ]),
      },
    };
    const map = await createDefaultSnippetLookup(client as never).resolve(["a"], "p1");
    expect(map.get("a")).toBe("function a() {}");
  });
});
