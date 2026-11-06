import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  applyFunctionMoves,
  chatCacheCorpusDir,
  extractGoFunctions,
  loadChatCacheFixture,
  pairLabel,
  parseChatCacheFixture,
  parseChatCachePatch,
} from "./fixture.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");

const base = () => ({
  id: "t",
  project: { corpus: "c", repo: "r" },
  questions: [
    { id: "a", text: "Which files import OPML?" },
    { id: "b", text: "Where is OPML imported?" },
    { id: "c", text: "Which files export OPML?" },
    { id: "d", text: "which files  import OPML?" },
  ],
  pairs: [
    { a: "a", b: "b", label: "paraphrase" },
    { a: "a", b: "c", label: "near-miss" },
    { a: "a", b: "d", label: "repeat" },
  ],
});

describe("parseChatCacheFixture", () => {
  it("accepts a well-formed set", () => {
    const f = parseChatCacheFixture(base());
    expect(f.questions).toHaveLength(4);
    expect(pairLabel(f.pairs, "b", "a")).toBe("paraphrase");
    expect(pairLabel(f.pairs, "b", "c")).toBeUndefined();
  });

  it.each([
    ["a duplicate id", (r: ReturnType<typeof base>) => r.questions.push({ id: "a", text: "x" })],
    ["an unknown pair member", (r: ReturnType<typeof base>) => (r.pairs[0].b = "zz")],
    ["an unknown label", (r: ReturnType<typeof base>) => (r.pairs[0].label = "synonym")],
    ["a self pair", (r: ReturnType<typeof base>) => (r.pairs[0].b = "a")],
    [
      "a repeated pair",
      (r: ReturnType<typeof base>) => r.pairs.push({ a: "b", b: "a", label: "near-miss" }),
    ],
    [
      "a repeat that normalises apart",
      (r: ReturnType<typeof base>) => {
        r.questions.push({ id: "e", text: "Which files import OPML today?" });
        r.pairs[2].b = "e";
      },
    ],
    [
      "a near-miss that normalises equal",
      (r: ReturnType<typeof base>) => {
        r.questions.push({ id: "e", text: "WHICH files import OPML?" });
        r.pairs[1].b = "e";
      },
    ],
    ["no paraphrase pair", (r: ReturnType<typeof base>) => r.pairs.splice(0, 1)],
    ["no questions", (r: ReturnType<typeof base>) => r.questions.splice(0)],
    ["an empty text", (r: ReturnType<typeof base>) => (r.questions[1].text = " ")],
  ])("rejects %s", (_name, mutate) => {
    const raw = base();
    mutate(raw);
    expect(() => parseChatCacheFixture(raw)).toThrow(/chat-cache fixture/);
  });

  it("names the rule a mislabelled pair broke", () => {
    const repeat = base();
    repeat.questions.push({ id: "e", text: "Which files import OPML today?" });
    repeat.pairs[2].b = "e";
    expect(() => parseChatCacheFixture(repeat)).toThrow(/labelled repeat but normalises apart/);
    const nearMiss = base();
    nearMiss.questions.push({ id: "e", text: "WHICH files import OPML?" });
    nearMiss.pairs[1].b = "e";
    expect(() => parseChatCacheFixture(nearMiss)).toThrow(
      /normalises equal but is labelled near-miss/,
    );
  });

  it("rejects a non-object", () => {
    expect(() => parseChatCacheFixture([])).toThrow(/not an object/);
    expect(() => parseChatCacheFixture({ ...base(), project: null })).toThrow(/project/);
  });
});

const patch = () => ({
  id: "p",
  commit: {
    message: "m",
    authorName: "n",
    authorEmail: "e@x.invalid",
    date: "2026-11-06T00:00:00Z",
  },
  moves: [{ from: "a/b.go", to: "a/c.go", header: "package a\n", functions: ["f"] }],
});

describe("parseChatCachePatch", () => {
  it("accepts a well-formed patch", () => {
    expect(parseChatCachePatch(patch()).moves[0].functions).toEqual(["f"]);
  });

  it.each([
    ["an absolute path", (p: ReturnType<typeof patch>) => (p.moves[0].to = "/etc/passwd")],
    [
      "a parent-directory path",
      (p: ReturnType<typeof patch>) => (p.moves[0].from = "a/../../x.go"),
    ],
    [
      "a non-identifier function",
      (p: ReturnType<typeof patch>) => (p.moves[0].functions = ["f()"]),
    ],
    ["no functions", (p: ReturnType<typeof patch>) => (p.moves[0].functions = [])],
    ["no moves", (p: ReturnType<typeof patch>) => (p.moves = [])],
    ["a bad date", (p: ReturnType<typeof patch>) => (p.commit.date = "yesterday")],
  ])("rejects %s", (_name, mutate) => {
    const raw = patch();
    mutate(raw);
    expect(() => parseChatCachePatch(raw)).toThrow(/chat-cache fixture/);
  });
});

const GO = [
  "package a",
  "",
  "// keep stays",
  "func keep() int {",
  "\treturn 1",
  "}",
  "",
  "// moved is documented",
  "// over two lines",
  "func moved(x string) string {",
  '\tif x == "" {',
  "\t\treturn x",
  "\t}",
  "\treturn x + x",
  "}",
  "",
  "func last() {}",
  "",
].join("\n");

describe("extractGoFunctions", () => {
  it("cuts a function with its doc comment and the blank line after it", () => {
    const { remaining, extracted } = extractGoFunctions(GO, ["moved"]);
    expect(extracted).toEqual([
      [
        "// moved is documented",
        "// over two lines",
        "func moved(x string) string {",
        '\tif x == "" {',
        "\t\treturn x",
        "\t}",
        "\treturn x + x",
        "}",
      ].join("\n"),
    ]);
    expect(remaining).toBe(
      [
        "package a",
        "",
        "// keep stays",
        "func keep() int {",
        "\treturn 1",
        "}",
        "",
        "func last() {}",
        "",
      ].join("\n"),
    );
  });

  it("refuses a missing or duplicated function", () => {
    expect(() => extractGoFunctions(GO, ["absent"])).toThrow(/found 0 times/);
    expect(() => extractGoFunctions(`${GO}\nfunc keep() {\n}\n`, ["keep"])).toThrow(
      /found 2 times/,
    );
  });

  it("refuses a function with no closing brace", () => {
    expect(() => extractGoFunctions("func open() {\n\treturn", ["open"])).toThrow(
      /no closing brace/,
    );
  });
});

describe("applyFunctionMoves", () => {
  const files: Record<string, string> = { "a/b.go": GO };
  const read = (p: string): string | null => files[p] ?? null;

  it("writes the source without the function and the new file with it", () => {
    const p = patch();
    p.moves[0].functions = ["moved"];
    const out = applyFunctionMoves(parseChatCachePatch(p).moves, read);
    expect(out.get("a/b.go")).not.toContain("func moved(");
    expect(out.get("a/c.go")).toBe(
      `package a\n\n${extractGoFunctions(GO, ["moved"]).extracted[0]}\n`,
    );
  });

  it("chains two moves out of one file", () => {
    const moves = [
      { from: "a/b.go", to: "a/c.go", header: "package a\n", functions: ["moved"] },
      { from: "a/b.go", to: "a/d.go", header: "package a\n", functions: ["last"] },
    ];
    const out = applyFunctionMoves(moves, read);
    expect(out.get("a/b.go")).not.toMatch(/func (moved|last)\(/);
    expect(out.get("a/d.go")).toContain("func last() {}");
  });

  it("never overwrites an existing file, and needs the source to exist", () => {
    expect(() =>
      applyFunctionMoves(
        [{ from: "a/b.go", to: "a/b.go", header: "", functions: ["moved"] }],
        read,
      ),
    ).toThrow(/already exists/);
    expect(() =>
      applyFunctionMoves(
        [{ from: "a/x.go", to: "a/y.go", header: "", functions: ["moved"] }],
        read,
      ),
    ).toThrow(/does not exist/);
  });
});

describe("the committed replay set", () => {
  it("parses, and carries the shape #1845 asks for", async () => {
    const { fixture, patch: p } = await loadChatCacheFixture(
      chatCacheCorpusDir(REPO_ROOT, "chatcache-01-miniflux"),
    );
    expect(fixture.questions.length).toBeGreaterThanOrEqual(40);
    const count = (label: string) => fixture.pairs.filter((x) => x.label === label).length;
    expect(count("paraphrase")).toBeGreaterThanOrEqual(5);
    expect(count("near-miss")).toBeGreaterThanOrEqual(5);
    expect(count("repeat")).toBeGreaterThanOrEqual(1);
    expect(fixture.project).toEqual({
      corpus: "localization-01-miniflux-heldout",
      repo: "miniflux",
    });
    expect(p.moves.length).toBeGreaterThan(0);
  });
});
