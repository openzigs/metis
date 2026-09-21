/**
 * TestRail exporter tests — issue #874.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../../src/lib/connectors/network-allowlist.js", () => ({
  assertConnectorHostAllowed: vi.fn(async () => {}),
  __resetAllowlistForTests: vi.fn(),
}));

import {
  exportSuggestionsToTestRail,
  type ExportableSuggestion,
} from "../../../src/lib/testcoverage/index.js";
import { assertConnectorHostAllowed } from "../../../src/lib/connectors/network-allowlist.js";

beforeEach(() => {
  (assertConnectorHostAllowed as ReturnType<typeof vi.fn>).mockClear();
  (assertConnectorHostAllowed as ReturnType<typeof vi.fn>).mockImplementation(async () => {});
});
afterEach(() => vi.restoreAllMocks());

function sample(overrides: Partial<ExportableSuggestion> = {}): ExportableSuggestion {
  return {
    id: "s1",
    title: "Login works",
    gwt: { given: ["valid user"], when: ["submit"], then: ["dashboard"] },
    steps: [{ action: "open page", expected: "form" }, { action: "submit" }],
    priority: "high",
    preconditions: undefined,
    expected: undefined,
    tags: ["smoke"],
    mappedRequirementIds: ["R-1"],
    faithfulness: 0.9,
    lowConfidence: false,
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("exportSuggestionsToTestRail", () => {
  it("dry-run skips all suggestions and issues no HTTP calls", async () => {
    const fetchFn = vi.fn() as unknown as typeof fetch;
    const r = await exportSuggestionsToTestRail(
      [sample()],
      { baseUrl: "https://tr.example.com", email: "u@x", apiKey: "k" },
      { sectionId: 7, dryRun: true },
      fetchFn,
    );
    expect(r.skipped).toHaveLength(1);
    expect(r.created).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("POSTs payload with refs, priority_id, and custom_steps_separated", async () => {
    const fetchFn = vi.fn(async (_url, init) => {
      const body = JSON.parse((init as RequestInit).body as string);
      expect(body.refs).toBe("s1");
      expect(body.priority_id).toBe(3);
      expect(body.title).toBe("Login works");
      expect(body.custom_steps_separated).toEqual([
        { content: "open page", expected: "form" },
        { content: "submit", expected: "" },
      ]);
      expect(body.custom_preconds).toContain("valid user");
      expect(body.custom_expected).toContain("dashboard");
      return jsonResponse(200, { id: 42 });
    }) as unknown as typeof fetch;

    const r = await exportSuggestionsToTestRail(
      [sample()],
      { baseUrl: "https://tr.example.com", email: "u@x", apiKey: "k" },
      { sectionId: 7 },
      fetchFn,
    );
    expect(r.created).toEqual([{ suggestionId: "s1", externalId: "42" }]);
  });

  it("captures partial failures without throwing", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { id: 1 }))
      .mockResolvedValueOnce(jsonResponse(403, { error: "no" }))
      .mockResolvedValueOnce(jsonResponse(200, { notId: 1 })) as unknown as typeof fetch;
    const r = await exportSuggestionsToTestRail(
      [sample({ id: "a" }), sample({ id: "b" }), sample({ id: "c" })],
      { baseUrl: "https://tr.example.com", email: "u@x", apiKey: "k" },
      { sectionId: 7 },
      fetchFn,
    );
    expect(r.created.map((c) => c.suggestionId)).toEqual(["a"]);
    expect(r.failed.map((f) => f.suggestionId).sort()).toEqual(["b", "c"]);
  });

  it("invokes the SSRF allow-list check", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(200, { id: 1 })) as unknown as typeof fetch;
    await exportSuggestionsToTestRail(
      [sample()],
      { baseUrl: "https://tr.example.com", email: "u@x", apiKey: "k" },
      { sectionId: 7 },
      fetchFn,
    );
    expect(assertConnectorHostAllowed).toHaveBeenCalledWith("tr.example.com", "testrail");
  });
});
