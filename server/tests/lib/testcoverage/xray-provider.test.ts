/**
 * Xray provider tests — issue #867.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../../src/lib/connectors/network-allowlist.js", () => ({
  assertConnectorHostAllowed: vi.fn(async () => {}),
  __resetAllowlistForTests: vi.fn(),
}));

import { importXrayTests, XrayClient } from "../../../src/lib/testcoverage/index.js";
import { assertConnectorHostAllowed } from "../../../src/lib/connectors/network-allowlist.js";

beforeEach(() => {
  (assertConnectorHostAllowed as ReturnType<typeof vi.fn>).mockClear();
  (assertConnectorHostAllowed as ReturnType<typeof vi.fn>).mockImplementation(async () => {});
});
afterEach(() => vi.restoreAllMocks());

function jsonResponse(status: number, body: unknown): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("XrayClient.authenticate", () => {
  it("strips wrapping quotes from the JWT", async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response('"my.jwt.token"', {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    ) as unknown as typeof fetch;
    const c = new XrayClient(
      { baseUrl: "https://xray.example.com", clientId: "id", clientSecret: "sec" },
      fetchFn,
    );
    const tok = await c.authenticate();
    expect(tok).toBe("my.jwt.token");
  });

  it("invokes the SSRF allow-list check before authenticating", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(200, '"tok"')) as unknown as typeof fetch;
    const c = new XrayClient(
      { baseUrl: "https://xray.example.com", clientId: "id", clientSecret: "sec" },
      fetchFn,
    );
    await c.authenticate();
    expect(assertConnectorHostAllowed).toHaveBeenCalledWith("xray.example.com", "xray");
  });

  it("throws when authenticate returns non-2xx", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse(403, { error: "no" }),
    ) as unknown as typeof fetch;
    const c = new XrayClient(
      { baseUrl: "https://xray.example.com", clientId: "id", clientSecret: "sec" },
      fetchFn,
    );
    await expect(c.authenticate()).rejects.toThrow(/Xray authenticate failed/);
  });
});

describe("importXrayTests", () => {
  it("imports tests with steps, preconditions, and pagination", async () => {
    const queue: Response[] = [
      jsonResponse(200, '"tok"'),
      jsonResponse(200, [
        {
          key: "PROJ-1",
          fields: {
            summary: "First",
            description: "pre",
            priority: { name: "High" },
            labels: ["smoke"],
          },
          steps: [
            { action: "open", data: "x", result: "ok" },
            { action: "click", result: "" },
          ],
        },
      ]),
      jsonResponse(200, [{ definition: "extra precondition" }]),
    ];
    let idx = 0;
    const fetchFn = vi.fn(
      async () => queue[idx++] ?? queue[queue.length - 1],
    ) as unknown as typeof fetch;

    const r = await importXrayTests(
      { baseUrl: "https://xray.example.com", clientId: "id", clientSecret: "sec" },
      { projectKey: "PROJ" },
      fetchFn,
    );
    expect(r.fetched).toBe(1);
    expect(r.cases).toHaveLength(1);
    expect(r.cases[0].externalId).toBe("PROJ-1");
    expect(r.cases[0].priority).toBe("high");
    expect(r.cases[0].preconditions).toContain("pre");
    expect(r.cases[0].preconditions).toContain("extra precondition");
    expect(r.cases[0].steps[0].action).toContain("open");
    expect(r.cases[0].steps[0].action).toContain("Data: x");
    expect(r.cases[0].steps[0].expected).toBe("ok");
    expect(r.cases[0].steps[1].expected).toBeUndefined();
  });

  it("retries authentication on 401 then proceeds", async () => {
    const queue: Response[] = [
      jsonResponse(200, '"tok1"'),
      jsonResponse(401, { error: "expired" }),
      jsonResponse(200, '"tok2"'),
      jsonResponse(200, []),
    ];
    let idx = 0;
    const fetchFn = vi.fn(
      async () => queue[idx++] ?? queue[queue.length - 1],
    ) as unknown as typeof fetch;
    const r = await importXrayTests(
      { baseUrl: "https://xray.example.com", clientId: "id", clientSecret: "sec" },
      { projectKey: "PROJ" },
      fetchFn,
    );
    expect(r.fetched).toBe(0);
    // initial auth + listTests(401) + re-auth + retry listTests
    expect((fetchFn as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(4);
  });
});
