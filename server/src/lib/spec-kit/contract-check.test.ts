/**
 * #1065 — the contract-vs-plan cross-check, without a model.
 */
import { describe, expect, it } from "vitest";
import {
  findContractPlanContradictions,
  listContractOperations,
  listPlanEndpoints,
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
      "> `REST surface`: none.",
      "rest surface — none",
      "REST surface: none  ",
      "**REST surface: none**",
    ]) {
      expect(planHasNoRestSurfaceMarker(`# Plan\n\n${line}\n`), line).toBe(true);
    }
    expect(planHasNoRestSurfaceMarker("REST surface: `PUT /entries`")).toBe(false);
    expect(planHasNoRestSurfaceMarker("The REST surface: none of it changes")).toBe(false);
  });

  // PR #1083 review — each near-miss differs from an accepted line in ONE respect.
  it("needs the marker to be the whole line: words after `none` make it a sentence", () => {
    // Starts exactly like the marker; no leading word, no endpoint, no fence.
    expect(planHasNoRestSurfaceMarker("REST surface: none of the existing endpoints change")).toBe(
      false,
    );
    expect(planHasNoRestSurfaceMarker("- REST surface: none yet, see below")).toBe(false);
    expect(planHasNoRestSurfaceMarker("REST surface: none (UI only)")).toBe(false);
    expect(planHasNoRestSurfaceMarker("REST surface: nonexistent")).toBe(false);
  });

  it("ignores the marker inside a fenced code block", () => {
    // No endpoint anywhere: only the fence can be what rejects these.
    const fenced = "# Plan\n\nThe template says:\n\n```md\nREST surface: none\n```\n\nDone.\n";
    expect(planHasNoRestSurfaceMarker(fenced)).toBe(false);
    expect(planHasNoRestSurfaceMarker("~~~\nREST surface: none\n~~~\n")).toBe(false);
    expect(planHasNoRestSurfaceMarker("> ```\n> REST surface: none\n> ```\n")).toBe(false);
    // The same line after the fence has closed is the marker again.
    expect(planHasNoRestSurfaceMarker("```md\nexample\n```\n\nREST surface: none\n")).toBe(true);
  });

  it("is not trusted when the plan also names a METHOD /path endpoint", () => {
    // The marker line itself is exact and outside any fence.
    expect(
      planHasNoRestSurfaceMarker("- REST surface: none\n- Adds `POST /entries/export`.\n"),
    ).toBe(false);
    expect(
      planHasNoRestSurfaceMarker("REST surface: none\n\n```http\nPOST /entries/export\n```\n"),
    ).toBe(false);
    // A bare path or a lower-case verb is not an endpoint statement.
    expect(
      planHasNoRestSurfaceMarker("REST surface: none\n\nThe UI already calls `/entries`.\n"),
    ).toBe(true);
    expect(planHasNoRestSurfaceMarker("REST surface: none\n\nWe get /entries today.\n")).toBe(true);
  });

  it("rejects the reviewer's two reproductions", () => {
    expect(
      planHasNoRestSurfaceMarker(
        "- REST surface: none of the existing endpoints change; adds `POST /entries/export`",
      ),
    ).toBe(false);
    expect(
      planHasNoRestSurfaceMarker("# Plan\n\nAdds `POST /x`.\n\n```md\nREST surface: none\n```\n"),
    ).toBe(false);
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

  // PR #1083 review — no extension, no other word: only the missing delimiter rejects these.
  it("does not read the tail of a file path, a template or a word as an endpoint path", () => {
    expect(planMentionsPath("Edit ui/src/app/entries", "/entries")).toBe(false);
    expect(planMentionsPath("Edit `ui/src/app/entries`.", "/src/app/entries")).toBe(false);
    expect(planMentionsPath("Written under specs/<slug>", "/entries/{entryID}")).toBe(false);
    expect(planMentionsPath("Retry and/or back off.", "/or")).toBe(false);
    expect(planMentionsPath("See https://example.com/entries", "/entries")).toBe(false);
    // The same paths, delimited, are mentions.
    expect(planMentionsPath("Calls `/entries` on load.", "/entries")).toBe(true);
    expect(planMentionsPath("Calls /entries on load.", "/entries")).toBe(true);
    expect(planMentionsPath("| PUT |/or |", "/or")).toBe(true);
  });

  it("does not match a contract path on its parameter alone", () => {
    expect(planMentionsPath("The route takes `/:id`.", "/entries/{entryID}")).toBe(false);
    expect(planMentionsPath("Under `/{slug}`.", "/tags/{id}")).toBe(false);
    // A parameter-only path still matches itself, and a literal tail still matches.
    expect(planMentionsPath("The route is `/:id`.", "/{entryID}")).toBe(true);
    expect(planMentionsPath("`/entries/:id`", "/v1/entries/{entryID}")).toBe(true);
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

  it("compares method and path together", () => {
    const post = "openapi: 3.1.0\npaths:\n  /entries:\n    post: {}\n";
    expect(
      findContractPlanContradictions([{ key: "c.yaml", content: post }], "Adds `GET /entries`."),
    ).toEqual(["`c.yaml` defines `POST /entries`, but plan.md names that path as `GET /entries`."]);
    // The same path under the same method agrees, whatever else the plan lists.
    expect(
      findContractPlanContradictions(
        [{ key: "c.yaml", content: post }],
        "Adds `POST /entries`. The page calls `/entries`.",
      ),
    ).toEqual([]);
    // A path named without any method cannot contradict one.
    expect(
      findContractPlanContradictions([{ key: "c.yaml", content: post }], "Calls `/entries`."),
    ).toEqual([]);
  });

  it("reports a plan endpoint the contract does not define", () => {
    const empty = "openapi: 3.1.0\npaths: {}\n";
    expect(
      findContractPlanContradictions(
        [{ key: "c.yaml", content: empty }],
        "Adds `DELETE /tags/{id}`.",
      ),
    ).toEqual([
      "plan.md names `DELETE /tags/{id}`, which `c.yaml` does not define (expected only for an existing endpoint this feature leaves unchanged).",
    ]);
    // One method of two is missing: only that one is reported, and once.
    const get = "openapi: 3.1.0\npaths:\n  /entries:\n    get: {}\n";
    expect(
      findContractPlanContradictions(
        [{ key: "c.yaml", content: get }],
        "Adds GET /entries and POST /entries. Again: POST /entries.",
      ),
    ).toEqual([
      "plan.md names `POST /entries`, which `c.yaml` does not define (expected only for an existing endpoint this feature leaves unchanged).",
    ]);
    // Defined in either of two contracts is defined.
    expect(
      findContractPlanContradictions(
        [
          { key: "a.yaml", content: get },
          { key: "b.yaml", content: empty },
        ],
        "Adds GET /entries and PUT /feeds/:id.",
      ),
    ).toEqual([
      "plan.md names `PUT /feeds/:id`, which no contract defines (expected only for an existing endpoint this feature leaves unchanged).",
    ]);
  });

  it("says nothing about plan endpoints when a contract is missing or unreadable", () => {
    expect(findContractPlanContradictions([], "Adds `DELETE /tags/{id}`.")).toEqual([]);
    expect(
      findContractPlanContradictions([{ key: "c", content: "words" }], "Adds `DELETE /tags/{id}`."),
    ).toEqual([]);
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

describe("listPlanEndpoints", () => {
  it("lists METHOD /path statements once each, with emphasis or a table bar between", () => {
    expect(
      listPlanEndpoints(
        "Adds `PUT /entries/mark-all-as-read`, **GET** `/entries/:id`. and | POST | /tags |. Again PUT /entries/mark-all-as-read.",
      ),
    ).toEqual([
      { method: "PUT", path: "/entries/mark-all-as-read" },
      { method: "GET", path: "/entries/:id" },
      { method: "POST", path: "/tags" },
    ]);
  });

  it("does not read prose, a lower-case verb, a file path or a bare slash as an endpoint", () => {
    expect(listPlanEndpoints("We get /entries and DELETE the row.")).toEqual([]);
    expect(listPlanEndpoints("POST ui/src/app/entries")).toEqual([]);
    expect(listPlanEndpoints("GET / POST are both allowed")).toEqual([]);
    expect(listPlanEndpoints("WIDGET /entries")).toEqual([]);
  });
});
