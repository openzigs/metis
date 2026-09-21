/**
 * Zephyr provider tests — issue #869.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../../src/lib/connectors/network-allowlist.js", () => ({
  assertConnectorHostAllowed: vi.fn(async () => {}),
  __resetAllowlistForTests: vi.fn(),
}));

import { importZephyrCases } from "../../../src/lib/testcoverage/index.js";
import { assertConnectorHostAllowed } from "../../../src/lib/connectors/network-allowlist.js";

beforeEach(() => {
  (assertConnectorHostAllowed as ReturnType<typeof vi.fn>).mockClear();
  (assertConnectorHostAllowed as ReturnType<typeof vi.fn>).mockImplementation(async () => {});
});
afterEach(() => vi.restoreAllMocks());

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("importZephyrCases", () => {
  it("sends Bearer token, paginates via isLast, fetches steps per case", async () => {
    const queue: Response[] = [
      // page 1: 1 case, isLast=false
      jsonResponse(200, {
        values: [
          {
            key: "Z-1",
            name: "first",
            precondition: "logged in",
            priority: { id: 1, name: "High" },
            labels: ["smoke"],
          },
        ],
        isLast: false,
      }),
      // steps for Z-1
      jsonResponse(200, {
        values: [
          { inline: { description: "step 1", expectedResult: "ok" } },
          { inline: { description: "step 2" } },
        ],
      }),
      // page 2: 1 case, isLast=true
      jsonResponse(200, {
        values: [{ key: "Z-2", name: "second" }],
        isLast: true,
      }),
      // steps for Z-2
      jsonResponse(200, { values: [] }),
    ];
    let idx = 0;
    const fetchFn = vi.fn(async (_url, init) => {
      const r = queue[idx++] ?? queue[queue.length - 1];
      // assert auth header on every call
      const headers = (init as RequestInit).headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer my-tok");
      return r;
    }) as unknown as typeof fetch;

    const r = await importZephyrCases(
      { baseUrl: "https://zephyr.example.com", bearerToken: "my-tok" },
      { projectKey: "PROJ", pageSize: 1 },
      fetchFn,
    );
    expect(r.fetched).toBe(2);
    expect(r.cases).toHaveLength(2);
    expect(r.cases[0].externalId).toBe("Z-1");
    expect(r.cases[0].preconditions).toBe("logged in");
    expect(r.cases[0].steps).toHaveLength(2);
    expect(r.cases[0].steps[0].expected).toBe("ok");
    expect(r.cases[0].steps[1].expected).toBeUndefined();
  });

  it("returns empty steps array on 404 from teststeps endpoint", async () => {
    const queue: Response[] = [
      jsonResponse(200, { values: [{ key: "Z-X", name: "x" }], isLast: true }),
      jsonResponse(404, {}),
    ];
    let idx = 0;
    const fetchFn = vi.fn(
      async () => queue[idx++] ?? queue[queue.length - 1],
    ) as unknown as typeof fetch;
    const r = await importZephyrCases(
      { baseUrl: "https://zephyr.example.com", bearerToken: "t" },
      { projectKey: "PROJ" },
      fetchFn,
    );
    expect(r.cases[0].steps).toEqual([]);
  });

  it("invokes the SSRF allow-list check for zephyr", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse(200, { values: [], isLast: true, startAt: 0, maxResults: 100, total: 0 }),
    ) as unknown as typeof fetch;
    await importZephyrCases(
      { baseUrl: "https://zephyr.example.com", token: "t" },
      { projectKey: "P" },
      fetchFn,
    );
    expect(assertConnectorHostAllowed).toHaveBeenCalledWith("zephyr.example.com", "zephyr");
  });
});
