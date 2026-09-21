/**
 * Issue #887 (epic #879) — unit tests for the pure detection helpers in
 * `mybatis-callsite-extractor.ts`. End-to-end / "neuter-and-red" reachability
 * coverage (`service → mapper method → statement → table`) lives in
 * `ingest-mybatis-callsite-wiring.test.ts`, mirroring the #884 wiring test
 * layout (`ingest-mybatis-wiring.test.ts` vs `mybatis-extractor.test.ts`).
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- lightweight in-memory Prisma/writer fakes */
import { describe, expect, it, vi } from "vitest";
import {
  buildJavaMapperIndex,
  buildMapperMethodsBySimpleName,
  buildMapperMethodSymbolIndex,
  findMapperCallSites,
  findMapperFieldTypes,
  persistMapperCallerEdges,
  persistMyBatisStatementOriginEdges,
  type JavaMapperInterface,
  type MyBatisStatementOrigin,
} from "../src/lib/code-graph/mybatis-callsite-extractor.js";
import {
  SchemaGraphWriter,
  type SchemaEdgeCreateData,
  type SchemaGraphPrisma,
  type SchemaSymbolCreateData,
} from "../src/lib/code-graph/schema-graph.js";

const fooMapperJava = `package com.acme;

public interface FooMapper {

    Account findAccount(long id);
}
`;

const fooServiceJava = `package com.acme.service;

import com.acme.FooMapper;

public class FooService {

    private FooMapper fooMapper;

    public Account getAccount(long id) {
        return fooMapper.findAccount(id);
    }
}
`;

describe("buildJavaMapperIndex", () => {
  it("indexes an interface file by its FQCN (package.Interface)", () => {
    const idx = buildJavaMapperIndex(new Map([["mapper/FooMapper.java", fooMapperJava]]));
    expect(idx.get("com.acme.FooMapper")).toEqual({
      fqcn: "com.acme.FooMapper",
      filePath: "mapper/FooMapper.java",
      simpleName: "FooMapper",
    });
  });

  it("uses the bare interface name when there is no package statement", () => {
    const idx = buildJavaMapperIndex(
      new Map([["Bare.java", "public interface Bare {\n  void x();\n}\n"]]),
    );
    expect(idx.get("Bare")).toEqual({ fqcn: "Bare", filePath: "Bare.java", simpleName: "Bare" });
  });

  it("skips non-.java files and .java files with no interface declaration", () => {
    const idx = buildJavaMapperIndex(
      new Map([
        ["mapper/Foo.xml", '<mapper namespace="x"></mapper>'],
        ["FooService.java", fooServiceJava], // a class, not an interface
      ]),
    );
    expect(idx.size).toBe(0);
  });
});

describe("findMapperFieldTypes", () => {
  it("finds a private field declared with a known mapper type", () => {
    const types = findMapperFieldTypes(fooServiceJava, new Set(["FooMapper"]));
    expect(types.get("fooMapper")).toBe("FooMapper");
  });

  it("finds a constructor-parameter declaration", () => {
    const src = "class X {\n  X(FooMapper fooMapper) { this.fooMapper = fooMapper; }\n}\n";
    const types = findMapperFieldTypes(src, new Set(["FooMapper"]));
    expect(types.get("fooMapper")).toBe("FooMapper");
  });

  it("does not treat a method signature as a field declaration", () => {
    // `Account findAccount(long id)` — the identifier before `(` must never be
    // captured as a mapper-typed variable named "findAccount".
    const types = findMapperFieldTypes(fooMapperJava, new Set(["Account"]));
    expect(types.has("findAccount")).toBe(false);
  });

  it("ignores unknown types", () => {
    const types = findMapperFieldTypes(fooServiceJava, new Set(["BarMapper"]));
    expect(types.size).toBe(0);
  });

  it("returns empty immediately when mapperNames is empty", () => {
    expect(findMapperFieldTypes(fooServiceJava, new Set()).size).toBe(0);
  });
});

describe("findMapperCallSites", () => {
  it("finds a call site against a field of known mapper type, with its line number", () => {
    const sites = findMapperCallSites(fooServiceJava, new Set(["FooMapper"]));
    expect(sites).toHaveLength(1);
    expect(sites[0]).toMatchObject({
      varName: "fooMapper",
      methodName: "findAccount",
      mapperSimpleName: "FooMapper",
    });
    expect(fooServiceJava.split("\n")[sites[0].line - 1]).toContain("findAccount");
  });

  it("returns nothing when the receiver's type is not a known mapper", () => {
    expect(findMapperCallSites(fooServiceJava, new Set(["BarMapper"]))).toEqual([]);
  });

  it("returns nothing for a source with no mapper-typed field at all", () => {
    const src = "class X {\n  void run() { helper.doThing(); }\n}\n";
    expect(findMapperCallSites(src, new Set(["FooMapper"]))).toEqual([]);
  });

  it("ignores a call site on a variable NOT in the field-type map, in a file that also has a mapper field", () => {
    // FooService also has an unrelated `helper.doThing()` call — the mapper
    // field's presence must not cause an unrelated receiver to be captured.
    const src = fooServiceJava.replace(
      "return fooMapper.findAccount(id);",
      "helper.doThing(); return fooMapper.findAccount(id);",
    );
    const sites = findMapperCallSites(src, new Set(["FooMapper"]));
    expect(sites).toHaveLength(1);
    expect(sites[0].varName).toBe("fooMapper");
  });
});

describe("buildMapperMethodSymbolIndex", () => {
  it("bulk-queries method symbols for the given mapper file paths, indexed by file then name", async () => {
    const rows = [
      { id: "m1", filePath: "mapper/FooMapper.java", name: "findAccount" },
      { id: "m2", filePath: "mapper/BarMapper.java", name: "findBar" },
    ];
    const prisma = { codeSymbol: { findMany: vi.fn(async () => rows) } };
    const idx = await buildMapperMethodSymbolIndex(prisma as any, "g1", [
      "mapper/FooMapper.java",
      "mapper/BarMapper.java",
    ]);
    expect(idx.get("mapper/FooMapper.java")?.get("findAccount")).toBe("m1");
    expect(idx.get("mapper/BarMapper.java")?.get("findBar")).toBe("m2");
    expect(prisma.codeSymbol.findMany).toHaveBeenCalledWith({
      where: {
        codeGraphId: "g1",
        filePath: { in: ["mapper/FooMapper.java", "mapper/BarMapper.java"] },
        kind: { in: ["method"] },
      },
      select: { id: true, filePath: true, name: true },
    });
  });

  it("short-circuits with an empty map and no query for an empty file-path list", async () => {
    const prisma = { codeSymbol: { findMany: vi.fn(async () => []) } };
    const idx = await buildMapperMethodSymbolIndex(prisma as any, "g1", []);
    expect(idx.size).toBe(0);
    expect(prisma.codeSymbol.findMany).not.toHaveBeenCalled();
  });

  it("first-seen id wins for a duplicate (file, name) pair", async () => {
    const rows = [
      { id: "first", filePath: "F.java", name: "m" },
      { id: "second", filePath: "F.java", name: "m" },
    ];
    const prisma = { codeSymbol: { findMany: vi.fn(async () => rows) } };
    const idx = await buildMapperMethodSymbolIndex(prisma as any, "g1", ["F.java"]);
    expect(idx.get("F.java")?.get("m")).toBe("first");
  });
});

describe("buildMapperMethodsBySimpleName", () => {
  it("joins the FQCN index with the resolved method-symbol index by simple name", () => {
    const javaMapperIndex = new Map<string, JavaMapperInterface>([
      [
        "com.acme.FooMapper",
        { fqcn: "com.acme.FooMapper", filePath: "F.java", simpleName: "FooMapper" },
      ],
    ]);
    const methodSymbolsByFile = new Map([["F.java", new Map([["findAccount", "m1"]])]]);
    const out = buildMapperMethodsBySimpleName(javaMapperIndex, methodSymbolsByFile);
    expect(out.get("FooMapper")?.get("findAccount")).toBe("m1");
  });

  it("omits a mapper with no resolved method symbols", () => {
    const javaMapperIndex = new Map<string, JavaMapperInterface>([
      [
        "com.acme.FooMapper",
        { fqcn: "com.acme.FooMapper", filePath: "F.java", simpleName: "FooMapper" },
      ],
    ]);
    const out = buildMapperMethodsBySimpleName(javaMapperIndex, new Map());
    expect(out.size).toBe(0);
  });
});

function fakeWriter(): {
  writer: SchemaGraphWriter;
  symbols: SchemaSymbolCreateData[];
  edges: SchemaEdgeCreateData[];
} {
  const symbols: SchemaSymbolCreateData[] = [];
  const edges: SchemaEdgeCreateData[] = [];
  let n = 0;
  const prisma: SchemaGraphPrisma = {
    codeSymbol: {
      create: async ({ data }) => {
        symbols.push(data);
        return { id: `${data.kind}-${++n}` };
      },
    },
    codeEdge: {
      create: async ({ data }) => {
        edges.push(data);
      },
    },
  };
  return { writer: new SchemaGraphWriter(prisma, "g1", "p1"), symbols, edges };
}

describe("persistMyBatisStatementOriginEdges", () => {
  const origin: MyBatisStatementOrigin = {
    symbolId: "stmt-1",
    namespace: "com.acme.FooMapper",
    statementId: "findAccount",
    qualifiedName: "com.acme.FooMapper.findAccount",
    line: 5,
  };
  const javaMapperIndex = new Map<string, JavaMapperInterface>([
    [
      "com.acme.FooMapper",
      { fqcn: "com.acme.FooMapper", filePath: "mapper/FooMapper.java", simpleName: "FooMapper" },
    ],
  ]);
  const methodSymbolsByFile = new Map([
    ["mapper/FooMapper.java", new Map([["findAccount", "method-1"]])],
  ]);

  it("writes an `executes` edge from the real method symbol to the statement origin", async () => {
    const { writer, edges } = fakeWriter();
    const count = await persistMyBatisStatementOriginEdges(
      writer,
      [origin],
      javaMapperIndex,
      methodSymbolsByFile,
    );
    expect(count).toBe(1);
    expect(edges).toEqual([
      {
        codeGraphId: "g1",
        projectId: "p1",
        kind: "executes",
        fromSymbolId: "method-1",
        toSymbolId: "stmt-1",
        toQualifiedName: "com.acme.FooMapper.findAccount",
        filePath: "mapper/FooMapper.java",
        line: 5,
        source: "mybatis",
        metadata: null,
      },
    ]);
  });

  it("skips a statement with no namespace", async () => {
    const { writer, edges } = fakeWriter();
    const count = await persistMyBatisStatementOriginEdges(
      writer,
      [{ ...origin, namespace: null }],
      javaMapperIndex,
      methodSymbolsByFile,
    );
    expect(count).toBe(0);
    expect(edges).toHaveLength(0);
  });

  it("skips a statement whose namespace has no matching Java mapper interface", async () => {
    const { writer, edges } = fakeWriter();
    const count = await persistMyBatisStatementOriginEdges(
      writer,
      [{ ...origin, namespace: "com.unknown.Nope" }],
      javaMapperIndex,
      methodSymbolsByFile,
    );
    expect(count).toBe(0);
    expect(edges).toHaveLength(0);
  });

  it("skips a statement whose method name has no resolved symbol in the mapper file", async () => {
    const { writer, edges } = fakeWriter();
    const count = await persistMyBatisStatementOriginEdges(
      writer,
      [{ ...origin, statementId: "notAMethod" }],
      javaMapperIndex,
      methodSymbolsByFile,
    );
    expect(count).toBe(0);
    expect(edges).toHaveLength(0);
  });
});

describe("persistMapperCallerEdges", () => {
  const methodsBySimpleName = new Map([["FooMapper", new Map([["findAccount", "method-1"]])]]);
  const symbols = [{ id: "caller-1", startLine: 1, endLine: 10 }];

  function fakeCodeEdgePrisma() {
    const edges: any[] = [];
    return {
      prisma: { codeEdge: { create: async ({ data }: any) => void edges.push(data) } },
      edges,
    };
  }

  it("writes an ordinary `calls` edge (source: null) from the enclosing caller symbol to the mapper method", async () => {
    const { prisma, edges } = fakeCodeEdgePrisma();
    const count = await persistMapperCallerEdges(
      prisma as any,
      "g1",
      "p1",
      "service/FooService.java",
      fooServiceJava,
      methodsBySimpleName,
      symbols,
    );
    expect(count).toBe(1);
    expect(edges).toEqual([
      {
        codeGraphId: "g1",
        projectId: "p1",
        kind: "calls",
        fromSymbolId: "caller-1",
        toSymbolId: "method-1",
        toQualifiedName: "FooMapper.findAccount",
        filePath: "service/FooService.java",
        line: 10,
        source: null,
      },
    ]);
  });

  it("skips a call site with no enclosing persisted symbol (empty symbol list)", async () => {
    const { prisma, edges } = fakeCodeEdgePrisma();
    const count = await persistMapperCallerEdges(
      prisma as any,
      "g1",
      "p1",
      "service/FooService.java",
      fooServiceJava,
      methodsBySimpleName,
      [],
    );
    expect(count).toBe(0);
    expect(edges).toHaveLength(0);
  });

  it("skips a call site whose line falls outside every persisted symbol's span", async () => {
    const { prisma, edges } = fakeCodeEdgePrisma();
    // A non-empty symbol list whose span does NOT cover the call site's line
    // (the call is on line 10; this symbol only covers lines 1-2) — exercises
    // the `enclosingSymbolFor` miss branch separately from the empty-list
    // short-circuit above.
    const count = await persistMapperCallerEdges(
      prisma as any,
      "g1",
      "p1",
      "service/FooService.java",
      fooServiceJava,
      methodsBySimpleName,
      [{ id: "unrelated-1", startLine: 1, endLine: 2 }],
    );
    expect(count).toBe(0);
    expect(edges).toHaveLength(0);
  });

  it("skips a call site whose method name doesn't resolve on the mapper", async () => {
    const src = fooServiceJava.replace("findAccount", "deleteAccount");
    const { prisma, edges } = fakeCodeEdgePrisma();
    const count = await persistMapperCallerEdges(
      prisma as any,
      "g1",
      "p1",
      "service/FooService.java",
      src,
      methodsBySimpleName,
      symbols,
    );
    expect(count).toBe(0);
    expect(edges).toHaveLength(0);
  });

  it("dedupes repeated (from, to) call sites within the same enclosing symbol", async () => {
    const src = fooServiceJava.replace(
      "return fooMapper.findAccount(id);",
      "fooMapper.findAccount(id); return fooMapper.findAccount(id);",
    );
    const { prisma, edges } = fakeCodeEdgePrisma();
    const count = await persistMapperCallerEdges(
      prisma as any,
      "g1",
      "p1",
      "service/FooService.java",
      src,
      methodsBySimpleName,
      symbols,
    );
    expect(count).toBe(1);
    expect(edges).toHaveLength(1);
  });
});
