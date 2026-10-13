/**
 * #1071 — the positive control for `go-verdicts.ts`.
 *
 * The helper exists because its predecessor let two calls share a key, so a
 * test written for one asserted on the other and could not fail. It refuses
 * instead of guessing — and PR #1104's third adversarial panel found that
 * removing either refusal failed no test. These do.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { initCodeGraphParsers } from "../../src/lib/code-graph/parsers.js";
import { goVerdicts, GoVerdicts, showGoVerdict } from "./go-verdicts.js";

const TWICE = `package p

type A struct{}

func (A) Run() {}

type B struct{}

func (B) Run() {}

func once() {}

func use(a A, b B) {
	a.Run()
	b.Run()
	once()
}
`;

describe("goVerdicts refuses to guess which call a test means", () => {
  beforeAll(async () => {
    await initCodeGraphParsers();
  });

  it("two calls of one name on ONE line throw when the tree is read", () => {
    const src = "package p\n\nfunc f() {}\n\nfunc g() {\n\tf(); f()\n}\n";
    expect(() => goVerdicts({ "p/p.go": src })).toThrow(
      'GoVerdicts: two calls share the key "p/p.go:6:f"',
    );
  });

  it("adding the same key twice throws, whatever the verdicts are", () => {
    const v = new GoVerdicts();
    v.add("p/p.go", 3, "f", { kind: "unknown" });
    expect(() => v.add("p/p.go", 3, "f", { kind: "unbound", reason: "external" })).toThrow(
      /two calls share the key/,
    );
    expect(v.size).toBe(1);
  });

  it("the `file:callee` shorthand throws when the file makes that call more than once", () => {
    const v = goVerdicts({ "p/p.go": TWICE });
    expect(() => v.get("p/p.go:Run")).toThrow(
      'GoVerdicts: "p/p.go:Run" names 2 calls (lines 14, 15)',
    );
  });

  it("…and each of the two is still reachable, by line, with its OWN verdict", () => {
    const v = goVerdicts({ "p/p.go": TWICE });
    expect(v.get("p/p.go:14:Run")).toBe("receiver-type p/p.go::A::Run");
    expect(v.get("p/p.go:15:Run")).toBe("receiver-type p/p.go::B::Run");
    // In source order: the first is not the last.
    expect(v.all("p/p.go:Run")).toEqual([
      "receiver-type p/p.go::A::Run",
      "receiver-type p/p.go::B::Run",
    ]);
  });

  it("the shorthand answers for a call the file makes once, and nothing for one it does not make", () => {
    const v = goVerdicts({ "p/p.go": TWICE });
    expect(v.get("p/p.go:once")).toBe("same-package p/p.go::once");
    expect(v.get("p/p.go:16:once")).toBe("same-package p/p.go::once");
    expect(v.get("p/p.go:never")).toBeUndefined();
    expect(v.get("p/p.go:99:once")).toBeUndefined();
    expect(v.all("p/p.go:never")).toEqual([]);
    expect(v.size).toBe(3);
    expect(v.values()).toHaveLength(3);
    expect(v.entries().map(([key]) => key)).toEqual([
      "p/p.go:14:Run",
      "p/p.go:15:Run",
      "p/p.go:16:once",
    ]);
    expect(v.raw.get("p/p.go:16:once")).toEqual({
      kind: "bound",
      qualifiedName: "p/p.go::once",
      via: "same-package",
    });
  });

  it("a verdict prints as one comparable string", () => {
    expect(
      showGoVerdict({ kind: "bound", qualifiedName: "a.go::T::M", via: "receiver-type" }),
    ).toBe("receiver-type a.go::T::M");
    expect(showGoVerdict({ kind: "unbound", reason: "interface" })).toBe("unbound interface");
    expect(showGoVerdict({ kind: "unknown", why: "budget" })).toBe("unknown");
  });
});
