/**
 * #1135 — a plan that calls code it was given "not visible", and a plan that
 * renames a parameter the request states.
 */
import { describe, expect, it, vi } from "vitest";
import {
  MAX_LOOKED_UP_NAMES,
  createDefaultSymbolFileLookup,
  declaresFunction,
  describeNotVisibleClaims,
  describeParameterRenames,
  findNotVisibleClaims,
  findParameterRenames,
} from "./plan-checks.js";

const findMany = vi.hoisted(() => vi.fn());
vi.mock("../prisma.js", () => ({ prisma: { codeSymbol: { findMany } } }));

const QB = "internal/storage/entry_query_builder.go";
const FILES = [QB, "internal/model/entry.go", "internal/googlereader/handler.go"];
/** The #4479 plan's context: `WithLimit`'s file, with its source excerpt. */
const QB_SOURCE = [
  "func (e *EntryQueryBuilder) WithLimit(limit int) *EntryQueryBuilder {",
  "\tif limit > 0 {",
  "\t\te.limit = limit",
  "\t}",
  "\treturn e",
  "}",
].join("\n");
const CONTEXT = { files: FILES, excerpts: [{ filePath: QB, text: QB_SOURCE }] };
/** The same files, with `WithLimit` named only by its locator: no source shown. */
const LOCATOR_ONLY = { files: FILES };
const lookup = async (names: string[]) =>
  new Map(
    names.flatMap((n): Array<[string, string[]]> =>
      n === "WithLimit" ? [[n, [QB]]] : n === "parseCount" ? [[n, ["internal/other.go"]]] : [],
    ),
  );

describe("findNotVisibleClaims", () => {
  it("flags a function the plan calls not visible whose file it was given (the #4479 plan)", async () => {
    const plan = [
      "## Risks & mitigations",
      "- The semantics of `WithLimit` are not visible in the retrieved context, so the cap is assumed to be a parse-time default.",
      "- `parseCount` is not visible either.",
      "- `WithLimit` is called by the four stream handlers.",
    ].join("\n");
    const claims = await findNotVisibleClaims(plan, CONTEXT, lookup);
    expect(claims).toEqual([{ named: "WithLimit", file: QB }]);
    expect(describeNotVisibleClaims(claims, "plan-context.md")).toBe(
      " Check: plan.md says it could not see `WithLimit` (in `internal/storage/entry_query_builder.go`), but that file was in the plan's context (`plan-context.md`) — read it before trusting what the plan says about it.",
    );
  });

  it("flags a listed file the plan says is not in the retrieved context, once", async () => {
    const plan =
      "The model file (`internal/model/entry.go`) is not in the retrieved context. Again: `internal/model/entry.go` cannot be seen.";
    const claims = await findNotVisibleClaims(plan, CONTEXT, lookup);
    expect(claims).toEqual([{ named: "internal/model/entry.go", file: "internal/model/entry.go" }]);
    expect(describeNotVisibleClaims(claims, null)).toBe(
      " Check: plan.md says it could not see `internal/model/entry.go`, but that file was in the plan's context — read it before trusting what the plan says about it.",
    );
  });

  it("says nothing of a file truly absent, a sentence with no such claim, or an empty context", async () => {
    const lookupSpy = vi.fn(lookup);
    expect(
      await findNotVisibleClaims(
        "`client/python.py` is not in the retrieved context.",
        CONTEXT,
        lookupSpy,
      ),
    ).toEqual([]);
    expect(lookupSpy).not.toHaveBeenCalled();
    expect(await findNotVisibleClaims("`WithLimit` clamps to 1000.", CONTEXT, lookup)).toEqual([]);
    // Symptom wording of a UI bug is not a claim about the context.
    const symptom =
      "After `parseCount` the entries are not shown because `WithLimit` is invisible to the user and they cannot see it.";
    expect(await findNotVisibleClaims(symptom, CONTEXT, lookup)).toEqual([]);
    expect(
      await findNotVisibleClaims("`WithLimit` is not visible.", { files: [] }, lookup),
    ).toEqual([]);
    expect(describeNotVisibleClaims([], "plan-context.md")).toBe("");
  });

  it("does NOT flag a function the context named only by its locator (PR #1164 panel)", async () => {
    const plan =
      "`WithLimit` (internal/storage/entry_query_builder.go:120-125) is not visible in the retrieved context; read it to confirm the cap.";
    expect(await findNotVisibleClaims(plan, LOCATOR_ONLY, lookup)).toEqual([]);
    // A source excerpt of the file that only CALLS it shows no body either.
    const callerOnly = {
      files: FILES,
      excerpts: [{ filePath: QB, text: "\treturn q.WithLimit(5)" }],
    };
    expect(await findNotVisibleClaims(plan, callerOnly, lookup)).toEqual([]);
    // Shown: as a source excerpt that declares it, or as a code snippet.
    expect(await findNotVisibleClaims(plan, CONTEXT, lookup)).toEqual([
      { named: "WithLimit", file: QB },
    ]);
    const lookupSpy = vi.fn(lookup);
    expect(
      await findNotVisibleClaims(
        plan,
        { files: FILES, bodies: [{ name: "WithLimit", filePath: QB }] },
        lookupSpy,
      ),
    ).toEqual([{ named: "WithLimit", file: QB }]);
    expect(lookupSpy).not.toHaveBeenCalled();
  });

  it("declaresFunction: a declaration, not a call", () => {
    expect(declaresFunction(QB_SOURCE, "WithLimit")).toBe(true);
    expect(declaresFunction("def with_limit(n):", "with_limit")).toBe(true);
    expect(declaresFunction("  public List<Entry> withLimit(int n) {", "withLimit")).toBe(true);
    expect(declaresFunction("export function withLimit(n: number) {", "withLimit")).toBe(true);
    expect(declaresFunction("  withLimit(n: number): this {", "withLimit")).toBe(true);
    expect(declaresFunction("export const withLimit = (n) => n;", "withLimit")).toBe(true);
    expect(declaresFunction("\treturn q.WithLimit(5)", "WithLimit")).toBe(false);
    expect(declaresFunction("func run() { q.WithLimit(5) }", "WithLimit")).toBe(false);
    expect(declaresFunction("func WithLimitAll(n int) {", "WithLimit")).toBe(false);
    // A name that is not a bare identifier is never compiled into a pattern.
    expect(declaresFunction("func a.b(", "a.b")).toBe(false);
  });

  it("declaresFunction: a line that only CALLS the name is not a declaration (PR #1164 re-review)", () => {
    for (const line of [
      "WithLimit(10).then(() => {",
      "  WithLimit(() => {",
      "export function handler(req) { return WithLimit(5) }",
      "private static final Query Q = WithLimit(3);",
      "void WithLimit(x);",
      "\tWithLimit(10).Run(func() {",
      "  return WithLimit(5);",
      "  await WithLimit(1) {",
      "const q = WithLimit(3);",
    ]) {
      expect(declaresFunction(line, "WithLimit"), line).toBe(false);
    }
    // Every declaration shape stays recognised.
    for (const line of [
      "func WithLimit(limit int) *Builder {",
      "func (e *EntryQueryBuilder) WithLimit(limit int) *EntryQueryBuilder {",
      "func WithLimit[T any](limit T) {",
      "def WithLimit(self, n):",
      "async def WithLimit(n):",
      "export function WithLimit(n: number) {",
      "export default async function WithLimit<T>(n: T) {",
      "  public List<Entry> WithLimit(int n) {",
      "  private static Query WithLimit(int n)",
      "  public void WithLimit(int n) {",
      "  public async Task<Query> WithLimit(int n) {",
      "pub fn WithLimit(n: usize) -> Self {",
      "  WithLimit(n: number): this {",
      "  async WithLimit(n) {",
      "export const WithLimit = (n) => n;",
      "const WithLimit = async function (n) {",
      "  override fun WithLimit(n: Int): Query {",
      "suspend fun WithLimit(n: Int) {",
    ]) {
      expect(declaresFunction(line, "WithLimit"), line).toBe(true);
    }
  });

  it("does NOT flag a function whose excerpt only calls it, end to end (PR #1164 re-review)", async () => {
    const plan = "`WithLimit` is not visible in the retrieved context.";
    const excerpt = { filePath: QB, text: "func list() {\n\tWithLimit(10).Run(func() {" };
    expect(await findNotVisibleClaims(plan, { files: FILES, excerpts: [excerpt] }, lookup)).toEqual(
      [],
    );
  });

  it("declaresFunction stays linear on adversarial source text", () => {
    const line = `  func WithLimit${"( ".repeat(300)}`;
    const text = Array.from({ length: 400 }, () => line).join("\n"); // ~240 KB
    const started = performance.now();
    expect(declaresFunction(text, "WithLimit")).toBe(true);
    // No keyword and no `{`: every line is tried against every pattern, and fails.
    expect(declaresFunction(text.replace(/func /g, ""), "WithLimit")).toBe(false);
    // Modifier and type words the Java shape could split many ways, and a generic never closed.
    const javaish = Array.from(
      { length: 400 },
      () => `${"public static ".repeat(30)}List<${"Map<A ".repeat(20)} WithLimit`,
    ).join("\n");
    expect(declaresFunction(javaish, "WithLimit")).toBe(false);
    expect(performance.now() - started).toBeLessThan(250);
  });

  it("pluralises", () => {
    expect(
      describeNotVisibleClaims(
        [
          { named: "a.go", file: "a.go" },
          { named: "F", file: "b.go" },
        ],
        "plan-context.md",
      ),
    ).toContain("but those files were in the plan's context (`plan-context.md`) — read them");
  });
});

describe("createDefaultSymbolFileLookup", () => {
  it("reads the project's functions by name, capped, and groups their files", async () => {
    findMany.mockResolvedValueOnce([
      { name: "WithLimit", filePath: QB },
      { name: "WithLimit", filePath: "vendor/x.go" },
    ]);
    const names = Array.from({ length: MAX_LOOKED_UP_NAMES + 5 }, (_, i) => `F${i}`);
    const files = await createDefaultSymbolFileLookup("p1")(["WithLimit", ...names]);
    expect(files.get("WithLimit")).toEqual([QB, "vendor/x.go"]);
    const where = findMany.mock.calls[0]![0].where;
    expect(where.projectId).toBe("p1");
    expect(where.name.in).toHaveLength(MAX_LOOKED_UP_NAMES);
    expect(where.kind).toEqual({ in: ["function", "method"] });
  });
});

describe("findParameterRenames", () => {
  // The J2.4 case (#4336): the request says read_at_after / read_at_before.
  const SPEC =
    'Support filtering entries by a reading-time window (FR: "support filtering with read_at_after / read_at_before"). Each entry gets `read_at`; see `entry_query_builder.go` and internal/model/entry_test.go.';

  it("reports a stated name the plan replaced with one sharing its first and last part", () => {
    const plan =
      "Add `read_at` to entries, and the filters read_after / read_before on `GET /v1/entries`.";
    const renames = findParameterRenames(SPEC, plan);
    expect(renames).toEqual([
      { stated: "read_at_after", usedInstead: ["read_after"] },
      { stated: "read_at_before", usedInstead: ["read_before"] },
    ]);
    expect(describeParameterRenames(renames)).toBe(
      " Check: plan.md renames names the spec states (`read_at_after` → `read_after`, `read_at_before` → `read_before`) without saying why — keep the spec's name or record the rename and its reason.",
    );
  });

  it("does not call an added part a rename (user_id -> user_feed_id)", () => {
    expect(findParameterRenames("Filter by user_id.", "Filter by user_feed_id.")).toEqual([]);
    expect(findParameterRenames("Sort by created_at.", "Sort by created_updated_at.")).toEqual([]);
  });

  it("is quiet when the plan keeps the names, or records the rename", () => {
    expect(
      findParameterRenames(SPEC, "Filters read_at_after and read_at_before on `read_at`."),
    ).toEqual([]);
    expect(
      findParameterRenames(
        SPEC,
        "ADR: rename read_at_after to read_after and read_at_before to read_before, matching published_after.",
      ),
    ).toEqual([]);
  });

  it("ignores a stated name the plan simply does not use, and file names", () => {
    expect(findParameterRenames(SPEC, "Nothing relevant here: entry_query_test")).toEqual([]);
    expect(describeParameterRenames([])).toBe("");
    expect(describeParameterRenames([{ stated: "a_b", usedInstead: ["a_x_b"] }])).toContain(
      "renames a name the spec states (`a_b` → `a_x_b`)",
    );
  });
});
