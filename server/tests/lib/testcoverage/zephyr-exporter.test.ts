/**
 * Zephyr exporter tests — issue #869.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../../src/lib/connectors/network-allowlist.js", () => ({
  assertConnectorHostAllowed: vi.fn(async () => {}),
  __resetAllowlistForTests: vi.fn(),
}));

import {
  exportSuggestionsToZephyr,
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
    title: "Login",
    gwt: { given: ["pre"], when: ["w"], then: ["t"] },
    steps: [{ action: "open", expected: "shown" }],
    priority: "critical",
    tags: ["ui"],
    mappedRequirementIds: [],
    faithfulness: 0.8,
    lowConfidence: false,
    ...o,
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("exportSuggestionsToZephyr", () => {
  it("creates case then APPENDs steps; maps critical → High", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchFn = vi.fn(async (url, init) => {
      const body = JSON.parse((init as RequestInit).body as string);
      calls.push({ url: String(url), body });
      if (String(url).endsWith("/testcases")) return json(201, { key: "ZS-99" });
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;

    const r = await exportSuggestionsToZephyr(
      [sample()],
      { baseUrl: "https://zep.example.com", bearerToken: "tok" },
      { projectKey: "PROJ" },
      fetchFn,
    );
    expect(r.created).toEqual([{ suggestionId: "s1", externalId: "ZS-99" }]);
    expect(calls).toHaveLength(2);
    expect(calls[0].body).toMatchObject({
      projectKey: "PROJ",
      name: "Login",
      priority: { name: "High" },
    });
    expect(calls[1].url).toContain("/teststeps");
    expect(calls[1].url).toContain("mode=APPEND");
    expect(calls[1].body).toMatchObject({ mode: "APPEND" });
  });

  it("skips step POST when suggestion has no steps", async () => {
    const fetchFn = vi.fn(async (url) => {
      if (String(url).endsWith("/testcases")) return json(201, { key: "K-1" });
      throw new Error("should not call /teststeps");
    }) as unknown as typeof fetch;
    const r = await exportSuggestionsToZephyr(
      [sample({ steps: [] })],
      { baseUrl: "https://zep.example.com", bearerToken: "t" },
      { projectKey: "P" },
      fetchFn,
    );
    expect(r.created).toHaveLength(1);
    expect((fetchFn as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it("captures failure when create returns non-2xx", async () => {
    const fetchFn = vi.fn(async () => json(500, { error: "x" })) as unknown as typeof fetch;
    const r = await exportSuggestionsToZephyr(
      [sample()],
      { baseUrl: "https://zep.example.com", bearerToken: "t" },
      { projectKey: "P" },
      fetchFn,
    );
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0].reason).toContain("HTTP 500");
  });

  it("dry-run returns skipped without HTTP", async () => {
    const fetchFn = vi.fn() as unknown as typeof fetch;
    const r = await exportSuggestionsToZephyr(
      [sample()],
      { baseUrl: "https://zep.example.com", bearerToken: "t" },
      { projectKey: "P", dryRun: true },
      fetchFn,
    );
    expect(r.skipped).toHaveLength(1);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
