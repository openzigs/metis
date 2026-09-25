/**
 * Every file of every documentable directory lands in some module (nothing is
 * dropped by the directory rules), and there is no module-count cap.
 */
import { describe, expect, it } from "vitest";
import { groupSymbolsIntoModules, type GroupableSymbol } from "./module-grouping.js";

let n = 0;
const sym = (
  kind: string,
  filePath: string,
  over: Partial<GroupableSymbol> = {},
): GroupableSymbol => ({
  id: `s${n++}`,
  qualifiedName: `${filePath}::${kind}${n}`,
  kind,
  filePath,
  startLine: 1,
  endLine: 10,
  language: "ts",
  ...over,
});
const group = (symbols: GroupableSymbol[]) =>
  groupSymbolsIntoModules(
    symbols,
    () => undefined,
    (_r, p) => p,
  );
const filesOf = (modules: ReturnType<typeof group>) =>
  new Set(modules.flatMap((m) => m.syms.map((s) => s.filePath)));

describe("groupSymbolsIntoModules", () => {
  it("keeps a qualifying directory as one module, as before", () => {
    const modules = group([
      sym("class", "src/a/A.ts"),
      sym("method", "src/a/A.ts"),
      sym("function", "src/a/b.ts"),
    ]);
    expect(modules).toHaveLength(1);
    expect(modules[0].dir).toBe("src/a");
  });

  it("adds a module-level-only file (only its `module` row) to its directory's module", () => {
    const modules = group([
      sym("class", "src/a/A.ts"),
      sym("method", "src/a/A.ts"),
      sym("function", "src/a/b.ts"),
      sym("module", "src/a/schema.ts"),
      sym("type", "src/a/schema.ts"),
    ]);
    expect(modules).toHaveLength(1);
    expect(filesOf(modules).has("src/a/schema.ts")).toBe(true);
    expect(
      modules[0].syms.filter((s) => s.filePath === "src/a/schema.ts").map((s) => s.kind),
    ).toEqual(["module"]);
  });

  it("gathers the class-less files of a split (>200-symbol) directory into a per-directory module", () => {
    const withClass = [
      sym("class", "src/g/Scene.ts"),
      sym("method", "src/g/Scene.ts"),
      sym("method", "src/g/Scene.ts"),
    ];
    const classless = Array.from({ length: 210 }, (_, i) =>
      sym("function", `src/g/util${i % 3}.test.ts`),
    );
    const modules = group([...withClass, ...classless]);
    expect(modules.map((m) => m.dir).sort()).toEqual(["src/g", "src/g/Scene"]);
    expect(modules.find((m) => m.dir === "src/g")!.syms).toHaveLength(210);
  });

  it("documents a directory too small for the directory rules instead of dropping it", () => {
    const modules = group([sym("function", "src/tiny/ids.ts"), sym("function", "src/tiny/ids.ts")]);
    expect(modules).toHaveLength(1);
    expect(modules[0].dir).toBe("src/tiny");
  });

  it("still never documents excluded directories", () => {
    expect(
      group([sym("function", "src/tests/unit/x.ts"), sym("function", "a/node_modules/p/i.js")]),
    ).toEqual([]);
  });

  it("has no module-count cap", () => {
    const symbols = Array.from({ length: 400 }, (_, i) => [
      sym("class", `src/m${i}/C.ts`),
      sym("method", `src/m${i}/C.ts`),
      sym("method", `src/m${i}/C.ts`),
    ]).flat();
    expect(group(symbols)).toHaveLength(400);
  });

  it("puts every file with a symbol into exactly one module", () => {
    const symbols = [
      ...Array.from({ length: 250 }, (_, i) =>
        sym("function", `big/f${i % 5}.py`, { language: "py" }),
      ),
      sym("class", "big/K.py"),
      sym("method", "big/K.py"),
      sym("method", "big/K.py"),
      sym("module", "big/consts.py"),
      sym("function", "small/one.ts"),
      sym("interface", "types/only.ts"),
    ];
    const modules = group(symbols);
    const owners = new Map<string, number>();
    for (const m of modules)
      for (const fp of new Set(m.syms.map((s) => s.filePath)))
        owners.set(fp, (owners.get(fp) ?? 0) + 1);
    for (const fp of new Set(symbols.map((s) => s.filePath))) expect(owners.get(fp), fp).toBe(1);
  });
});
