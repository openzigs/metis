/**
 * #1065 — the contract-vs-plan cross-check, without a model.
 */
import { describe, expect, it } from "vitest";
import {
  findContractPlanContradictions,
  listContractOperations,
  planDeclaresNoRestSurface,
  planHasNoRestSurfaceMarker,
  planMentionsPath,
} from "./contract-check.js";

const CONTRACT = [
  "openapi: 3.1.0",
  "info:",
  "  title: T",
  "  version: 1.0.0",
  "paths:",
  "  /entries/mark-all-as-read:",
  "    put:",
  "      responses:",
  "        '204': { description: done }",
  "  /entries/{entryID}:",
  "    parameters: []",
  "    get:",
  "      responses:",
  "        '200': { description: ok }",
].join("\n");

describe("listContractOperations", () => {
  it("lists every method of every path, ignoring non-operation keys", () => {
    expect(listContractOperations(CONTRACT)).toEqual([
      { method: "PUT", path: "/entries/mark-all-as-read" },
      { method: "GET", path: "/entries/{entryID}" },
    ]);
  });

  it("returns [] for a contract with no paths, and null for text that is not a mapping", () => {
    expect(listContractOperations("openapi: 3.1.0\npaths: {}\n")).toEqual([]);
    expect(listContractOperations("openapi: 3.1.0\n")).toEqual([]);
    expect(listContractOperations("openapi: 3.1.0\npaths:\n  /x: nope\n")).toEqual([]);
    expect(listContractOperations("just words")).toBeNull();
    expect(listContractOperations("- a\n- b\n")).toBeNull();
    expect(listContractOperations("a: [unclosed")).toBeNull();
  });
});

describe("the plan's no-REST declaration", () => {
  it("reads the marker line, with list or emphasis characters around it", () => {
    for (const line of [
      "REST surface: none",
      "- **REST surface:** none",
      "> `REST surface`: none (UI only)",
      "rest surface — none",
    ]) {
      expect(planHasNoRestSurfaceMarker(`# Plan\n\n${line}\n`), line).toBe(true);
    }
    expect(planHasNoRestSurfaceMarker("REST surface: `PUT /entries`")).toBe(false);
    expect(planHasNoRestSurfaceMarker("The REST surface: none of it changes")).toBe(false);
  });

  it("also reads the prose form, but not a sentence that goes on to add an endpoint", () => {
    expect(planDeclaresNoRestSurface("No REST endpoint is in scope for this feature.")).toBe(true);
    expect(planDeclaresNoRestSurface("No new API routes are added.")).toBe(true);
    expect(planDeclaresNoRestSurface("There is no REST endpoint for this today; add one.")).toBe(
      false,
    );
    expect(planHasNoRestSurfaceMarker("No REST endpoint is in scope.")).toBe(false);
  });
});

describe("planMentionsPath", () => {
  it("matches the same path whatever the parameter spelling", () => {
    expect(planMentionsPath("Add `GET /entries/:id`.", "/entries/{entryID}")).toBe(true);
    expect(planMentionsPath("Add GET /entries/<id>.", "/entries/{entryID}")).toBe(true);
    expect(planMentionsPath("Calls /Entries/Mark-All-As-Read.", "/entries/mark-all-as-read")).toBe(
      true,
    );
  });

  it("matches under a prefix on either side", () => {
    expect(planMentionsPath("PUT /v1/entries/mark-all-as-read", "/entries/mark-all-as-read")).toBe(
      true,
    );
    expect(planMentionsPath("PUT /entries/mark-all-as-read", "/api/entries/mark-all-as-read")).toBe(
      true,
    );
  });

  it("does not match a different path or a file that merely shares a word", () => {
    expect(planMentionsPath("Edit `internal/api/entries.go`.", "/entries")).toBe(false);
    expect(planMentionsPath("PUT /entries/star", "/entries/mark-all-as-read")).toBe(false);
    expect(planMentionsPath("No paths here.", "/entries")).toBe(false);
  });

  it("treats the root path as mentioned", () => {
    expect(planMentionsPath("nothing", "/")).toBe(true);
  });
});

describe("findContractPlanContradictions", () => {
  const contracts = [{ key: "contracts/api.openapi.yaml", content: CONTRACT }];

  it("flags every operation when the plan says no REST endpoint is in scope", () => {
    const plan = "# Plan\n\nNo REST endpoint is in scope. The UI calls /entries/mark-all-as-read.";
    expect(findContractPlanContradictions(contracts, plan)).toEqual([
      "plan.md states that no REST endpoint is in scope, but `contracts/api.openapi.yaml` defines `PUT /entries/mark-all-as-read`.",
      "plan.md states that no REST endpoint is in scope, but `contracts/api.openapi.yaml` defines `GET /entries/{entryID}`.",
    ]);
  });

  it("flags an operation whose path the plan never names", () => {
    const plan = "# Plan\n\nAdd `GET /entries/:id` to the API.";
    expect(findContractPlanContradictions(contracts, plan)).toEqual([
      "`contracts/api.openapi.yaml` defines `PUT /entries/mark-all-as-read`, which plan.md never mentions.",
    ]);
  });

  it("is empty when they agree, for an empty contract and for an unparseable one", () => {
    const plan = "Add `PUT /entries/mark-all-as-read` and `GET /entries/{id}`.";
    expect(findContractPlanContradictions(contracts, plan)).toEqual([]);
    expect(
      findContractPlanContradictions(
        [{ key: "contracts/api.openapi.yaml", content: "openapi: 3.1.0\npaths: {}\n" }],
        "REST surface: none",
      ),
    ).toEqual([]);
    expect(findContractPlanContradictions([{ key: "c", content: "words" }], "plan")).toEqual([]);
  });
});
