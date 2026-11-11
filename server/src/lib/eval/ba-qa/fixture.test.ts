import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BAQA_CORPUS,
  baQaCorpusDir,
  expectedSourceFiles,
  isMultiTurn,
  loadBaQaFixture,
  parseBaQaFixture,
  requiredCodeFiles,
} from "./fixture.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const SHA = "c4d54f87a81b30aa173fddf05d7ff83ae7da5796";

const base = () => ({
  id: "t",
  version: 1,
  issue: 1,
  description: "d",
  license: "l",
  authoredBy: "a",
  products: [
    {
      name: "srv",
      title: "Server",
      url: "https://github.com/o/srv",
      ref: "1",
      sha: SHA,
      documents: [{ file: "frd.md", uploadAs: "FRD.md", fromCorpus: true }],
    },
    {
      name: "cli",
      title: "Client",
      url: "https://github.com/o/cli",
      ref: "1",
      sha: SHA,
      documents: [],
    },
  ],
  questions: [
    {
      id: "S1",
      category: "single-product",
      scope: ["srv"],
      text: "How?",
      expect: "answer",
      facts: [{ id: "S1.a", text: "f" }],
      sources: [
        { product: "srv", path: "a.go", lines: [1, 2] },
        { product: "srv", path: "a.go", lines: [5, 9] },
        { product: "srv", path: "FRD.md", kind: "doc" },
      ],
    },
    {
      id: "M1",
      category: "multi-product",
      scope: ["srv", "cli"],
      text: "What changes?",
      expect: "answer",
      facts: [{ id: "M1.a", text: "f" }],
      sources: [{ product: "cli", path: "c.py" }],
    },
    {
      id: "A1",
      category: "ambiguous",
      scope: ["srv", "cli"],
      text: "It?",
      expect: "follow-up",
      why: "no referent",
    },
  ],
});

type Raw = ReturnType<typeof base>;
const broken = (edit: (f: Raw) => void): Raw => {
  const f = base();
  edit(f);
  return f;
};

describe("parseBaQaFixture", () => {
  it("accepts a well-formed set", () => {
    expect(parseBaQaFixture(base()).questions.map((q) => q.id)).toEqual(["S1", "M1", "A1"]);
  });

  it.each<[string, (f: Raw) => void, RegExp]>([
    ["an unknown field", (f) => Object.assign(f, { extra: 1 }), /extra/],
    ["a duplicate product", (f) => f.products.push({ ...f.products[0] }), /listed twice/],
    ["a bad commit", (f) => (f.products[0].sha = "main"), /sha|commit/i],
    ["a non-GitHub url", (f) => (f.products[0].url = "https://example.com/x"), /github/i],
    [
      "two uploads under one name",
      (f) => f.products[0].documents.push({ file: "b.md", uploadAs: "FRD.md", fromCorpus: true }),
      /uploads two documents/,
    ],
    ["a duplicate question", (f) => f.questions.push({ ...f.questions[2] }), /A1 is listed twice/],
    ["an unknown scope", (f) => (f.questions[0].scope = ["nope"]), /unknown product nope/],
    ["a repeated scope", (f) => (f.questions[1].scope = ["srv", "srv"]), /names a product twice/],
    [
      "category and expectation disagree",
      (f) => (f.questions[2].expect = "answer"),
      /expects answer/,
    ],
    ["single-product over two", (f) => (f.questions[0].scope = ["srv", "cli"]), /single-product/],
    ["multi-product over one", (f) => (f.questions[1].scope = ["cli"]), /multi-product/],
    ["an answer with no facts", (f) => (f.questions[0].facts = []), /no facts/],
    ["an answer with no sources", (f) => (f.questions[0].sources = []), /no sources/],
    [
      "a fact of another question",
      (f) => (f.questions[0].facts![0].id = "M1.a"),
      /does not belong/,
    ],
    [
      "a fact listed twice",
      (f) => f.questions[0].facts!.push({ id: "S1.a", text: "g" }),
      /S1.a is listed twice/,
    ],
    [
      "a source outside the scope",
      (f) => (f.questions[0].sources![0].product = "cli"),
      /outside its scope/,
    ],
    [
      "a backwards range",
      (f) => ((f.questions[0].sources![0] as { lines?: number[] }).lines = [9, 2]),
      /backwards/,
    ],
    ["a path escaping the clone", (f) => (f.questions[0].sources![0].path = "../x.go"), /path/],
    [
      "a follow-up carrying facts",
      (f) => Object.assign(f.questions[2], { facts: [{ id: "A1.a", text: "f" }] }),
      /carries no facts/,
    ],
    ["a follow-up with no reason", (f) => delete (f.questions[2] as { why?: string }).why, /why/],
    [
      "earlier turns without saying whether the last refers back",
      (f) => Object.assign(f.questions[0], { before: ["First?"] }),
      /S1 has earlier turns but no refersBack/,
    ],
    [
      "refersBack on a one-turn question",
      (f) => Object.assign(f.questions[0], { refersBack: true }),
      /S1 has refersBack but no earlier turns/,
    ],
    [
      "an empty earlier turn",
      (f) => Object.assign(f.questions[0], { before: [""], refersBack: true }),
      /before/,
    ],
  ])("rejects %s", (_label, edit, message) => {
    expect(() => parseBaQaFixture(broken(edit))).toThrow(message);
  });
});

describe("multi-turn questions (#2269)", () => {
  it("accepts earlier turns with a refersBack label, and tells the sets apart", () => {
    const f = parseBaQaFixture(
      broken((raw) =>
        Object.assign(raw.questions[0], { before: ["How is it scheduled?"], refersBack: true }),
      ),
    );
    expect(f.questions[0].before).toEqual(["How is it scheduled?"]);
    expect(isMultiTurn(f.questions[0])).toBe(true);
    expect(isMultiTurn(f.questions[1])).toBe(false);
  });
});

describe("source helpers", () => {
  it("lists each expected file once, and only code files as required", () => {
    const f = parseBaQaFixture(base());
    expect(expectedSourceFiles(f.questions[0])).toEqual(["srv:FRD.md", "srv:a.go"]);
    expect(expectedSourceFiles(f.questions[2])).toEqual([]);
    expect(requiredCodeFiles(f)).toEqual(["cli:c.py", "srv:a.go"]);
  });

  it("refuses a corpus id that is not a plain name", () => {
    expect(() => baQaCorpusDir(REPO_ROOT, "../etc")).toThrow(/bad corpus id/);
  });
});

describe("the committed question set", () => {
  it("loads, covers every category over both products, and ships its FRD", async () => {
    const dir = baQaCorpusDir(REPO_ROOT, BAQA_CORPUS);
    const f = await loadBaQaFixture(dir);
    expect(f.products.map((p) => p.name)).toEqual(["miniflux", "python-client"]);
    const count = (c: string) => f.questions.filter((q) => q.category === c).length;
    expect(count("single-product")).toBeGreaterThanOrEqual(4);
    expect(count("multi-product")).toBeGreaterThanOrEqual(3);
    expect(count("ambiguous")).toBeGreaterThanOrEqual(3);
    expect(count("unanswerable")).toBeGreaterThanOrEqual(3);
    for (const p of f.products) {
      for (const d of p.documents.filter((x) => x.fromCorpus)) {
        expect(existsSync(path.join(dir, d.file))).toBe(true);
      }
    }
    // Each single-product product is asked about on its own at least once.
    const singles = new Set(
      f.questions.filter((q) => q.category === "single-product").map((q) => q.scope[0]),
    );
    expect([...singles].sort()).toEqual(["miniflux", "python-client"]);
  });

  it("holds a multi-turn set: follow-ups that refer back, and self-contained controls", async () => {
    const f = await loadBaQaFixture(baQaCorpusDir(REPO_ROOT, BAQA_CORPUS));
    const multi = f.questions.filter(isMultiTurn);
    expect(multi.filter((q) => q.refersBack).length).toBeGreaterThanOrEqual(4);
    expect(multi.filter((q) => q.refersBack === false).length).toBeGreaterThanOrEqual(2);
    // Each is asked in a session bound to one product, so retrieval runs.
    expect(multi.every((q) => q.category === "single-product")).toBe(true);
  });
});
