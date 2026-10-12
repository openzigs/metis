/**
 * #1071 — the Go resolver's verdict for every call of a small source tree, for
 * the tests that pin what binds and what must not.
 *
 * Each call is held under a key that is UNIQUE: `file:line:callee`. The helper
 * this replaces keyed by `file:callee`, so two calls to the same name in one
 * file shared an entry and the later one silently overwrote the earlier. A test
 * written for the first call then asserted on the second and could not fail
 * (PR #1104, second adversarial panel: the type-parameter rule sat behind
 * exactly that). So this one refuses instead of guessing:
 *
 *  - two calls that would share a key (same callee twice on one line) throw
 *    when the tree is read — put them on separate lines;
 *  - `get("file:callee")` is a shorthand that works only when the file makes
 *    that call ONCE, and throws when it makes it more than once — name the
 *    line, or use {@link GoVerdicts.all}.
 */
import {
  createGoResolver,
  type GoCallVerdict,
  type GoModule,
  type GoResolverOptions,
} from "../../src/lib/code-graph/go-type-resolution.js";
import { parseSource } from "../../src/lib/code-graph/parsers.js";

export type GoTree = Record<string, string>;

export const GO_TEST_MODULE: GoModule[] = [{ dir: "", path: "example.com/app" }];

/** A verdict as one comparable string: `receiver-type a/b.go::T::M`, `unbound external`, `unknown`. */
export function showGoVerdict(v: GoCallVerdict): string {
  if (v.kind === "bound") return `${v.via} ${v.qualifiedName}`;
  return v.kind === "unbound" ? `unbound ${v.reason}` : "unknown";
}

export class GoVerdicts {
  /** `file:line:callee` → verdict. */
  private readonly exact = new Map<string, string>();
  /** `file:callee` → every call of that name in the file, in source order. */
  private readonly named = new Map<string, Array<{ line: number; verdict: string }>>();
  /** The raw verdicts, for a test that needs more than the string. */
  readonly raw = new Map<string, GoCallVerdict>();

  add(filePath: string, line: number, callee: string, verdict: GoCallVerdict): void {
    const key = `${filePath}:${line}:${callee}`;
    if (this.exact.has(key)) {
      throw new Error(
        `GoVerdicts: two calls share the key "${key}" — put each call under test on its own line`,
      );
    }
    const shown = showGoVerdict(verdict);
    this.exact.set(key, shown);
    this.raw.set(key, verdict);
    const name = `${filePath}:${callee}`;
    const list = this.named.get(name);
    if (list) list.push({ line, verdict: shown });
    else this.named.set(name, [{ line, verdict: shown }]);
  }

  /**
   * The verdict for `file:line:callee`, or for `file:callee` when the file
   * makes that call exactly once. Throws on a `file:callee` the file makes
   * more than once: which call the test means cannot be guessed.
   */
  get(key: string): string | undefined {
    const parts = key.split(":");
    if (parts.length === 3 && /^\d+$/.test(parts[1])) return this.exact.get(key);
    const list = this.named.get(key);
    if (!list) return undefined;
    if (list.length > 1) {
      throw new Error(
        `GoVerdicts: "${key}" names ${list.length} calls (lines ${list.map((c) => c.line).join(", ")}) — ` +
          `ask for one by line ("file:line:callee") or use all()`,
      );
    }
    return list[0].verdict;
  }

  /** Every verdict for `file:callee`, in source order. */
  all(key: string): string[] {
    return (this.named.get(key) ?? []).map((c) => c.verdict);
  }

  /** Every verdict of the tree. */
  values(): string[] {
    return [...this.exact.values()];
  }

  /** Every `file:line:callee` → verdict pair. */
  entries(): Array<[string, string]> {
    return [...this.exact.entries()];
  }

  get size(): number {
    return this.exact.size;
  }
}

/** Run the real Go walker and resolver over `tree`; `_test.go` is a test file, as ingest decides it. */
export function goVerdicts(
  tree: GoTree,
  modules: GoModule[] = GO_TEST_MODULE,
  options?: GoResolverOptions,
): GoVerdicts {
  const parsed = Object.entries(tree).map(([filePath, src]) => parseSource(filePath, src, "go"));
  for (const p of parsed) {
    if (!p.goFacts) throw new Error(`GoVerdicts: ${p.filePath} did not parse`);
  }
  const resolver = createGoResolver(
    parsed.map((p) => ({
      filePath: p.filePath,
      facts: p.goFacts!,
      isTest: p.filePath.endsWith("_test.go"),
    })),
    modules,
    options,
  );
  const out = new GoVerdicts();
  for (const p of parsed) {
    for (const e of p.edges) {
      if (e.kind !== "calls") continue;
      out.add(p.filePath, e.line, e.toQualifiedName, resolver.resolveCall(p.filePath, e.goCallee!));
    }
  }
  return out;
}
