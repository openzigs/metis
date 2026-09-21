/**
 * Xray exporter tests — issue #867.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../../src/lib/connectors/network-allowlist.js", () => ({
  assertConnectorHostAllowed: vi.fn(async () => {}),
  __resetAllowlistForTests: vi.fn(),
}));

import {
  exportSuggestionsToXray,
  type ExportableSuggestion,
} from "../../../src/lib/testcoverage/index.js";
import { assertConnectorHostAllowed } from "../../../src/lib/connectors/network-allowlist.js";

beforeEach(() => {
  (assertConnectorHostAllowed as ReturnType<typeof vi.fn>).mockClear();
  (assertConnectorHostAllowed as ReturnType<typeof vi.fn>).mockImplementation(async () => {});
});
afterEach(() => vi.restoreAllMocks());

function sample(o: Partial<ExportableSuggestion> = {}): ExportableSuggestion {
  return {
    id: "s1",
    title: "T",
    gwt: { given: ["g"], when: ["w"], then: ["t"] },
    steps: [{ action: "a1", expected: "e1" }],
    priority: "medium",
    tags: ["smoke"],
    mappedRequirementIds: [],
    faithfulness: 0.8,
    lowConfidence: false,
    ...o,
  };
}
function json(status: number, body: unknown): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("exportSuggestionsToXray", () => {
  it("dry-run skips, no network", async () => {
    const fetchFn = vi.fn() as unknown as typeof fetch;
    const r = await exportSuggestionsToXray(
      [sample()],
      { baseUrl: "https://xray.example.com", clientId: "id", clientSecret: "sec" },
      { projectKey: "PROJ", dryRun: true },
      fetchFn,
    );
    expect(r.skipped).toHaveLength(1);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("authenticates then posts bulk payload and maps results", async () => {
    const queue: Response[] = [
      json(200, '"jwt"'),
      json(200, {
        results: [{ importedTest: { key: "PROJ-100" } }, { errors: ["bad"] }],
      }),
    ];
    let idx = 0;
    const fetchFn = vi.fn(async (url, init) => {
      const r = queue[idx++];
      if (idx === 2) {
        // bulk POST
        const body = JSON.parse((init as RequestInit).body as string) as unknown[];
        expect(Array.isArray(body)).toBe(true);
        expect(body).toHaveLength(2);
        expect(String(url)).toContain("api/v2/import/test/bulk");
      }
      return r;
    }) as unknown as typeof fetch;

    const r = await exportSuggestionsToXray(
      [sample({ id: "a" }), sample({ id: "b" })],
      { baseUrl: "https://xray.example.com", clientId: "id", clientSecret: "sec" },
      { projectKey: "PROJ" },
      fetchFn,
    );
    expect(r.created).toEqual([{ suggestionId: "a", externalId: "PROJ-100" }]);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0].suggestionId).toBe("b");
    expect(r.failed[0].reason).toContain("bad");
  });

  it("chunks suggestions at 100 and issues two bulk calls", async () => {
    const responses: Response[] = [
      json(200, '"jwt"'),
      json(200, {
        results: Array.from({ length: 100 }, (_, i) => ({ importedTest: { key: `K-${i}` } })),
      }),
      json(200, { results: [{ importedTest: { key: "K-101" } }] }),
    ];
    let idx = 0;
    const fetchFn = vi.fn(async () => responses[idx++]) as unknown as typeof fetch;
    const sugs = Array.from({ length: 101 }, (_, i) => sample({ id: `s${i}` }));
    const r = await exportSuggestionsToXray(
      sugs,
      { baseUrl: "https://xray.example.com", clientId: "id", clientSecret: "sec" },
      { projectKey: "PROJ" },
      fetchFn,
    );
    expect(r.created).toHaveLength(101);
    // 1 auth + 2 bulk
    expect((fetchFn as ReturnType<typeof vi.fn>).mock.calls.length).toBe(3);
  });

  it("fails an entire chunk when bulk POST is non-2xx", async () => {
    const responses: Response[] = [json(200, '"jwt"'), json(500, { error: "x" })];
    let idx = 0;
    const fetchFn = vi.fn(
      async () => responses[idx++] ?? responses[responses.length - 1],
    ) as unknown as typeof fetch;
    const r = await exportSuggestionsToXray(
      [sample({ id: "a" }), sample({ id: "b" })],
      { baseUrl: "https://xray.example.com", clientId: "id", clientSecret: "sec" },
      { projectKey: "PROJ" },
      fetchFn,
    );
    expect(r.failed.map((f) => f.suggestionId).sort()).toEqual(["a", "b"]);
  });
});
