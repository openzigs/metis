/**
 * TestRail provider tests — Epic #856 / issue #874.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../../src/lib/connectors/network-allowlist.js", () => ({
  assertConnectorHostAllowed: vi.fn(async () => {}),
  __resetAllowlistForTests: vi.fn(),
}));

import { importTestRailCases, retryingFetch } from "../../../src/lib/testcoverage/index.js";
import { assertConnectorHostAllowed } from "../../../src/lib/connectors/network-allowlist.js";

beforeEach(() => {
  (assertConnectorHostAllowed as ReturnType<typeof vi.fn>).mockClear();
  (assertConnectorHostAllowed as ReturnType<typeof vi.fn>).mockImplementation(async () => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mockFetch(responses: Array<{ status: number; body: unknown }>): typeof fetch {
  let idx = 0;
  return vi.fn(async () => {
    const r = responses[idx] ?? responses[responses.length - 1];
    idx++;
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

describe("importTestRailCases", () => {
  it("sends HTTP Basic auth and parses array-shaped response (v5)", async () => {
    const fetchFn = mockFetch([
      {
        status: 200,
        body: [
          {
            id: 1,
            title: "Login works",
            priority_id: 3,
            custom_preconds: "user exists",
            custom_steps_separated: [
              { content: "open login page", expected: "form visible" },
              { content: "enter creds", expected: "success" },
            ],
          },
        ],
      },
    ]);
    const result = await importTestRailCases(
      {
        baseUrl: "https://testrail.example.com",
        email: "user@example.com",
        apiKey: "abc123",
      },
      { projectId: 7 },
      fetchFn,
    );

    expect(result.fetched).toBe(1);
    expect(result.cases).toHaveLength(1);
    expect(result.cases[0].title).toBe("Login works");
    expect(result.cases[0].priority).toBe("high");
    expect(result.cases[0].steps).toHaveLength(2);
    expect(result.cases[0].steps[0].expected).toBe("form visible");

    const call = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toContain("get_cases/7");
    expect((call[1].headers as Record<string, string>).Authorization).toMatch(/^Basic /);
    const auth = (call[1].headers as Record<string, string>).Authorization.replace("Basic ", "");
    expect(Buffer.from(auth, "base64").toString()).toBe("user@example.com:abc123");
  });

  it("prefers custom_steps_separated over custom_steps", async () => {
    const fetchFn = mockFetch([
      {
        status: 200,
        body: [
          {
            id: 2,
            title: "Mixed steps",
            custom_steps: "old format\nshould not be used",
            custom_steps_separated: [{ content: "new step", expected: "ok" }],
          },
        ],
      },
    ]);
    const r = await importTestRailCases(
      { baseUrl: "https://testrail.example.com", email: "u@x", apiKey: "k" },
      { projectId: 1 },
      fetchFn,
    );
    expect(r.cases[0].steps).toHaveLength(1);
    expect(r.cases[0].steps[0].action).toBe("new step");
  });

  it("falls back to splitting custom_steps when separated is absent", async () => {
    const fetchFn = mockFetch([
      {
        status: 200,
        body: [{ id: 3, title: "Newline steps", custom_steps: "step one\nstep two" }],
      },
    ]);
    const r = await importTestRailCases(
      { baseUrl: "https://testrail.example.com", email: "u@x", apiKey: "k" },
      { projectId: 1 },
      fetchFn,
    );
    expect(r.cases[0].steps.map((s) => s.action)).toEqual(["step one", "step two"]);
  });

  it("invokes the SSRF allow-list check for testrail before any fetch", async () => {
    const fetchFn = mockFetch([{ status: 200, body: [] }]);
    await importTestRailCases(
      { baseUrl: "https://testrail.example.com", email: "u@x", apiKey: "k" },
      { projectId: 1 },
      fetchFn,
    );
    expect(assertConnectorHostAllowed).toHaveBeenCalledWith("testrail.example.com", "testrail");
  });

  it("paginates v6 object-shaped responses until _links.next is null", async () => {
    const fetchFn = mockFetch([
      {
        status: 200,
        body: { cases: [{ id: 1, title: "p1" }], size: 1, _links: { next: "x" } },
      },
      {
        status: 200,
        body: { cases: [{ id: 2, title: "p2" }], size: 1, _links: { next: null } },
      },
    ]);
    const r = await importTestRailCases(
      { baseUrl: "https://testrail.example.com", email: "u@x", apiKey: "k" },
      { projectId: 1, pageSize: 1 },
      fetchFn,
    );
    expect(r.fetched).toBe(2);
    expect(r.cases.map((c) => c.title)).toEqual(["p1", "p2"]);
  });
});

describe("retryingFetch", () => {
  it("retries on 429 with exponential backoff and eventually succeeds", async () => {
    const sleeps: number[] = [];
    const fetchFn = mockFetch([
      { status: 429, body: { msg: "rate" } },
      { status: 429, body: { msg: "rate" } },
      { status: 200, body: { ok: true } },
    ]);
    const res = await retryingFetch(
      fetchFn,
      "https://x.example.com/y",
      { method: "GET" },
      {
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    );
    expect(res.status).toBe(200);
    expect(sleeps.length).toBe(2);
    expect(sleeps[0]).toBeLessThan(sleeps[1]);
  });

  it("retries on 5xx and returns the last response on max attempts", async () => {
    const fetchFn = mockFetch([
      { status: 500, body: { msg: "err" } },
      { status: 500, body: { msg: "err" } },
      { status: 500, body: { msg: "err" } },
      { status: 500, body: { msg: "err" } },
    ]);
    const res = await retryingFetch(
      fetchFn,
      "https://x.example.com/y",
      { method: "GET" },
      {
        sleep: async () => {},
        maxAttempts: 4,
      },
    );
    expect(res.status).toBe(500);
  });

  it("rethrows underlying errors after maxAttempts", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    await expect(
      retryingFetch(
        fetchFn,
        "https://x.example.com/y",
        { method: "GET" },
        {
          sleep: async () => {},
          maxAttempts: 2,
        },
      ),
    ).rejects.toThrow("ECONNRESET");
  });

  it("wraps non-Error thrown values when surfacing the final failure", async () => {
    // Covers the `lastError instanceof Error ? lastError : new Error(...)` branch (line 187).
    // We force an unreachable fallthrough by feeding maxAttempts=0 so the for-loop never
    // assigns lastError, leaving it as the initial undefined.
    const fetchFn = vi.fn(
      async () => new Response("{}", { status: 200 }),
    ) as unknown as typeof fetch;
    await expect(
      retryingFetch(
        fetchFn,
        "https://x.example.com/y",
        { method: "GET" },
        {
          sleep: async () => {},
          maxAttempts: 0,
        },
      ),
    ).rejects.toThrow("retryingFetch failed");
  });
});

describe("testrail edge cases", () => {
  it("maps every documented priority level including critical and unknown", async () => {
    // Covers mapPriority `id===4 → critical` branch (line 146) plus default fallthrough.
    const fetchFn = mockFetch([
      {
        status: 200,
        body: [
          { id: 1, title: "Crit", priority_id: 4, custom_steps_separated: [] },
          { id: 2, title: "Unknown", priority_id: 99, custom_steps_separated: [] },
        ],
      },
    ]);
    const result = await importTestRailCases(
      { baseUrl: "https://t.example.com", email: "u@e", apiKey: "k" },
      { projectId: 1 },
      fetchFn,
    );
    expect(result.cases).toHaveLength(2);
    expect(result.cases[0].priority).toBe("critical");
  });

  it("normalises a baseUrl that already ends with a trailing slash", async () => {
    // Covers joinUrl `base.endsWith("/")` true branch (line 156).
    const fetchFn = mockFetch([{ status: 200, body: [] }]);
    await importTestRailCases(
      { baseUrl: "https://t.example.com/", email: "u@e", apiKey: "k" },
      { projectId: 1 },
      fetchFn,
    );
    const url = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    // Should not contain a double slash before "index.php".
    expect(url).not.toMatch(/\/\/index\.php/);
    expect(url).toContain("/index.php");
  });

  it("wraps non-Error thrown values when retryingFetch falls through", async () => {
    // Covers line 187: `lastError instanceof Error ? ... : new Error("retryingFetch failed")`.
    // maxAttempts=0 skips the loop entirely, leaving lastError as the initial undefined,
    // which triggers the wrapped-Error fallback.
    const fetchFn = vi.fn(
      async () => new Response("{}", { status: 200 }),
    ) as unknown as typeof fetch;
    await expect(
      retryingFetch(
        fetchFn,
        "https://x.example.com/y",
        { method: "GET" },
        {
          sleep: async () => {},
          maxAttempts: 0,
        },
      ),
    ).rejects.toThrow("retryingFetch failed");
  });
});
