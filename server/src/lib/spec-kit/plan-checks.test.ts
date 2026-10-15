/**
 * #1135 — a plan that calls code it was given "not visible", and a plan that
 * renames a parameter the request states.
 */
import { describe, expect, it, vi } from "vitest";
import {
  MAX_LOOKED_UP_NAMES,
  createDefaultSymbolFileLookup,
  describeNotVisibleClaims,
  describeParameterRenames,
  findNotVisibleClaims,
  findParameterRenames,
} from "./plan-checks.js";

const findMany = vi.hoisted(() => vi.fn());
vi.mock("../prisma.js", () => ({ prisma: { codeSymbol: { findMany } } }));

const QB = "internal/storage/entry_query_builder.go";
const CONTEXT = [QB, "internal/model/entry.go", "internal/googlereader/handler.go"];
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
    expect(await findNotVisibleClaims("`WithLimit` is not visible.", [], lookup)).toEqual([]);
    expect(describeNotVisibleClaims([], "plan-context.md")).toBe("");
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
