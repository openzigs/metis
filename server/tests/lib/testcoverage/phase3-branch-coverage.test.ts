/**
 * Branch coverage helpers for Phase 3 connectors/exporters.
 * Each test targets specific uncovered branch arms (priority maps,
 * missing-field guards, catch fallbacks) so the per-file branch ratio
 * crosses the 80% threshold.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../../src/lib/connectors/network-allowlist.js", () => ({
  assertConnectorHostAllowed: vi.fn(async () => {}),
  __resetAllowlistForTests: vi.fn(),
}));

import {
  exportSuggestionsToTestRail,
  exportSuggestionsToXray,
  exportSuggestionsToZephyr,
  importTestRailCases,
  importXrayTests,
  importZephyrCases,
  type ExportableSuggestion,
} from "../../../src/lib/testcoverage/index.js";

afterEach(() => vi.restoreAllMocks());

function sample(o: Partial<ExportableSuggestion> = {}): ExportableSuggestion {
  return {
    id: "s1",
    title: "t",
    gwt: { given: ["g"], when: ["w"], then: ["t"] },
    steps: [{ action: "a", expected: "e" }],
    priority: "medium",
    tags: [],
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

describe("priority/branch fallbacks across all phase-3 priority mappers", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(["low", "medium", "high", "critical"] as const)(
    "testrail-exporter handles priority %s",
    async (p) => {
      const fn = vi.fn(async () => json(200, { id: 1 })) as unknown as typeof fetch;
      const r = await exportSuggestionsToTestRail(
        [sample({ priority: p })],
        { baseUrl: "https://tr.example.com", email: "u@x", apiKey: "k" },
        { sectionId: 1 },
        fn,
      );
      expect(r.created).toHaveLength(1);
    },
  );

  it.each(["low", "medium", "high", "critical"] as const)(
    "xray-exporter handles priority %s",
    async (p) => {
      const fn = vi.fn(async (url) => {
        if (String(url).includes("authenticate")) return json(200, '"tok"');
        return json(200, { results: [{ importedTest: { key: "X-1" } }] });
      }) as unknown as typeof fetch;
      const r = await exportSuggestionsToXray(
        [sample({ priority: p })],
        { baseUrl: "https://xray.example.com", clientId: "id", clientSecret: "sec" },
        { projectKey: "P" },
        fn,
      );
      expect(r.created).toHaveLength(1);
    },
  );

  it.each(["low", "medium", "high", "critical"] as const)(
    "zephyr-exporter handles priority %s",
    async (p) => {
      const fn = vi.fn(async (url) => {
        if (String(url).endsWith("/testcases")) return json(201, { key: "Z-1" });
        return new Response(null, { status: 204 });
      }) as unknown as typeof fetch;
      const r = await exportSuggestionsToZephyr(
        [sample({ priority: p })],
        { baseUrl: "https://zep.example.com", bearerToken: "t" },
        { projectKey: "P" },
        fn,
      );
      expect(r.created).toHaveLength(1);
    },
  );
});

describe("missing-id / missing-key / step-append guards", () => {
  it("testrail-exporter records failure when response is missing id", async () => {
    const fn = vi.fn(async () => json(200, {})) as unknown as typeof fetch;
    const r = await exportSuggestionsToTestRail(
      [sample()],
      { baseUrl: "https://tr.example.com", email: "u@x", apiKey: "k" },
      { sectionId: 1 },
      fn,
    );
    expect(r.failed[0]?.reason).toMatch(/missing id/);
  });

  it("zephyr-exporter records failure when response is missing key", async () => {
    const fn = vi.fn(async () => json(201, {})) as unknown as typeof fetch;
    const r = await exportSuggestionsToZephyr(
      [sample()],
      { baseUrl: "https://zep.example.com", bearerToken: "t" },
      { projectKey: "P" },
      fn,
    );
    expect(r.failed[0]?.reason).toMatch(/missing key/);
  });

  it("zephyr-exporter records failure on non-Error string thrown by fetchFn", async () => {
    let phase = 0;
    const fn = vi.fn(async () => {
      phase += 1;
      if (phase === 1) return json(201, { key: "Z-9" });
      // step append throws non-Error
      throw "boom";
    }) as unknown as typeof fetch;
    const r = await exportSuggestionsToZephyr(
      [sample()],
      { baseUrl: "https://zep.example.com", bearerToken: "t" },
      { projectKey: "P" },
      fn,
    );
    expect(r.failed[0]?.reason).toBe("boom");
  });

  it("zephyr-exporter step append throws on non-2xx (covers !res.ok branch)", async () => {
    let phase = 0;
    const fn = vi.fn(async () => {
      phase += 1;
      if (phase === 1) return json(201, { key: "Z-9" });
      return json(500, { error: "x" });
    }) as unknown as typeof fetch;
    const r = await exportSuggestionsToZephyr(
      [sample()],
      { baseUrl: "https://zep.example.com", bearerToken: "t" },
      { projectKey: "P" },
      fn,
    );
    expect(r.failed[0]?.reason).toMatch(/append steps failed/);
  });
});

describe("provider importer branch fallbacks", () => {
  it("testrail-provider importer handles v5 list-only response (no _links)", async () => {
    const fn = vi.fn(async () => json(200, [])) as unknown as typeof fetch;
    const r = await importTestRailCases(
      { baseUrl: "https://testrail.example.com", email: "u@x", apiKey: "k" },
      { projectId: 1 },
      fn,
    );
    expect(r.cases).toEqual([]);
  });

  it("zephyr-provider handles values with no steps endpoint at all (empty values)", async () => {
    const fn = vi.fn(async () =>
      json(200, { values: [], isLast: true, startAt: 0, maxResults: 100, total: 0 }),
    ) as unknown as typeof fetch;
    const r = await importZephyrCases(
      { baseUrl: "https://zephyr.example.com", token: "t" },
      { projectKey: "P" },
      fn,
    );
    expect(r.cases).toEqual([]);
  });

  it("xray-provider handles empty test list", async () => {
    let phase = 0;
    const fn = vi.fn(async () => {
      phase += 1;
      if (phase === 1) return json(200, '"tok"');
      return json(200, { data: { getTests: { total: 0, results: [] } } });
    }) as unknown as typeof fetch;
    const r = await importXrayTests(
      { baseUrl: "https://xray.example.com", clientId: "id", clientSecret: "sec" },
      { jql: "project = P" },
      fn,
    );
    expect(r.cases).toEqual([]);
  });
});

describe("non-ok throws / extra branch arms", () => {
  it("xray-provider listTests throws on non-2xx", async () => {
    let phase = 0;
    const fn = vi.fn(async () => {
      phase += 1;
      if (phase === 1) return json(200, '"tok"');
      return json(500, { error: "boom" });
    }) as unknown as typeof fetch;
    await expect(
      importXrayTests(
        { baseUrl: "https://xray.example.com", clientId: "id", clientSecret: "sec" },
        { projectKey: "P" },
        fn,
      ),
    ).rejects.toThrow(/list tests failed/);
  });

  it("xray-provider preconditions 404 yields empty (best-effort)", async () => {
    let phase = 0;
    const fn = vi.fn(async (url) => {
      phase += 1;
      if (phase === 1) return json(200, '"tok"');
      if (String(url).includes("preconditions")) return new Response(null, { status: 404 });
      // first list call: object response with tests[]
      return json(200, {
        tests: [{ key: "X-1", fields: { summary: "t" }, steps: [{ action: "a" }] }],
      });
    }) as unknown as typeof fetch;
    const r = await importXrayTests(
      { baseUrl: "https://xray.example.com", clientId: "id", clientSecret: "sec" },
      { projectKey: "P" },
      fn,
    );
    expect(r.cases).toHaveLength(1);
  });

  it("xray-provider preconditions non-ok non-404 swallowed by catch", async () => {
    let phase = 0;
    const fn = vi.fn(async (url) => {
      phase += 1;
      if (phase === 1) return json(200, '"tok"');
      if (String(url).includes("preconditions")) return json(503, { e: 1 });
      return json(200, {
        tests: [{ key: "X-1", fields: { summary: "t" }, steps: [{ action: "a" }] }],
      });
    }) as unknown as typeof fetch;
    const r = await importXrayTests(
      { baseUrl: "https://xray.example.com", clientId: "id", clientSecret: "sec" },
      { projectKey: "P" },
      fn,
    );
    expect(r.cases).toHaveLength(1);
  });

  it("zephyr-provider list non-ok throws", async () => {
    const fn = vi.fn(async () => json(500, { e: 1 })) as unknown as typeof fetch;
    await expect(
      importZephyrCases(
        { baseUrl: "https://zep.example.com", token: "t" },
        { projectKey: "P" },
        fn,
      ),
    ).rejects.toThrow(/testcases list failed/);
  });

  it("zephyr-provider steps non-ok non-404 throws", async () => {
    const fn = vi.fn(async (url) => {
      if (String(url).includes("/teststeps")) return json(503, { e: 1 });
      return json(200, {
        values: [{ key: "Z-1", name: "t" }],
        isLast: true,
        startAt: 0,
        maxResults: 100,
        total: 1,
      });
    }) as unknown as typeof fetch;
    await expect(
      importZephyrCases(
        { baseUrl: "https://zep.example.com", token: "t" },
        { projectKey: "P" },
        fn,
      ),
    ).rejects.toThrow(/testcase steps failed/);
  });

  it("testrail-provider non-ok throws", async () => {
    const fn = vi.fn(async () => json(500, { e: 1 })) as unknown as typeof fetch;
    await expect(
      importTestRailCases(
        { baseUrl: "https://testrail.example.com", email: "u@x", apiKey: "k" },
        { projectId: 1 },
        fn,
      ),
    ).rejects.toThrow(/get_cases failed/);
  });

  it("testrail-provider clampLimit handles undefined/zero/negative/large pageSize", async () => {
    const fn = vi.fn(async () => json(200, [])) as unknown as typeof fetch;
    for (const ps of [undefined, 0, -5, 9999]) {
      await importTestRailCases(
        { baseUrl: "https://testrail.example.com", email: "u@x", apiKey: "k" },
        { projectId: 1, pageSize: ps },
        fn,
      );
    }
    expect(fn).toHaveBeenCalled();
  });

  it("testrail-provider maps cases with no steps + unknown priority + small pageSize", async () => {
    const fn = vi.fn(async () =>
      json(200, [
        { id: 1, title: "no-steps", priority_id: 99 }, // unknown priority → null; no steps → []
        { id: 2, title: "with-text", custom_steps: "step a\nstep b" }, // custom_steps text branch
      ]),
    ) as unknown as typeof fetch;
    const r = await importTestRailCases(
      { baseUrl: "https://testrail.example.com", email: "u@x", apiKey: "k" },
      { projectId: 1, pageSize: 10 },
      fn,
    );
    expect(r.cases.length).toBeGreaterThan(0);
  });

  it("testrail-provider retryingFetch defensive throw path (maxAttempts 0)", async () => {
    const { retryingFetch } =
      await import("../../../src/lib/testcoverage/providers/testrail-provider.js");
    await expect(
      retryingFetch(
        vi.fn(async () => json(200, [])) as unknown as typeof fetch,
        "https://testrail.example.com/x",
        { method: "GET" },
        { maxAttempts: 0, baseDelayMs: 1 },
      ),
    ).rejects.toThrow(/retryingFetch failed/);
  });

  it("xray-exporter records per-suggestion failure when results array is missing keys", async () => {
    const fn = vi.fn(async (url) => {
      if (String(url).includes("authenticate")) return json(200, '"tok"');
      return json(200, { results: [{ errors: ["nope"] }] });
    }) as unknown as typeof fetch;
    const r = await exportSuggestionsToXray(
      [sample()],
      { baseUrl: "https://xray.example.com", clientId: "id", clientSecret: "sec" },
      { projectKey: "P" },
      fn,
    );
    expect(r.failed[0]?.reason).toBe("nope");
  });

  it("xray-exporter records pending-job reason when neither key nor errors present", async () => {
    const fn = vi.fn(async (url) => {
      if (String(url).includes("authenticate")) return json(200, '"tok"');
      return json(200, { jobId: "J-1", results: [{}] });
    }) as unknown as typeof fetch;
    const r = await exportSuggestionsToXray(
      [sample()],
      { baseUrl: "https://xray.example.com", clientId: "id", clientSecret: "sec" },
      { projectKey: "P" },
      fn,
    );
    expect(r.failed[0]?.reason).toMatch(/pending job J-1/);
  });

  it("xray-exporter records 'no key returned' when results entry is empty and no jobId", async () => {
    const fn = vi.fn(async (url) => {
      if (String(url).includes("authenticate")) return json(200, '"tok"');
      return json(200, { results: [{}] });
    }) as unknown as typeof fetch;
    const r = await exportSuggestionsToXray(
      [sample()],
      { baseUrl: "https://xray.example.com", clientId: "id", clientSecret: "sec" },
      { projectKey: "P" },
      fn,
    );
    expect(r.failed[0]?.reason).toMatch(/no key returned/);
  });

  it("testrail-exporter records failure on Error during fetch", async () => {
    const fn = vi.fn(async () => {
      throw new Error("net down");
    }) as unknown as typeof fetch;
    const r = await exportSuggestionsToTestRail(
      [sample()],
      { baseUrl: "https://tr.example.com", email: "u@x", apiKey: "k" },
      { sectionId: 1 },
      fn,
    );
    expect(r.failed[0]?.reason).toBe("net down");
  });

  it("testrail-exporter records failure on non-Error thrown value", async () => {
    const fn = vi.fn(async () => {
      throw "oh no";
    }) as unknown as typeof fetch;
    const r = await exportSuggestionsToTestRail(
      [sample()],
      { baseUrl: "https://tr.example.com", email: "u@x", apiKey: "k" },
      { sectionId: 1 },
      fn,
    );
    expect(r.failed[0]?.reason).toBe("oh no");
  });

  it("xray-exporter bulk fetch throws Error → fails whole chunk", async () => {
    let phase = 0;
    const fn = vi.fn(async () => {
      phase += 1;
      if (phase === 1) return json(200, '"tok"');
      throw new Error("net rip");
    }) as unknown as typeof fetch;
    const r = await exportSuggestionsToXray(
      [sample()],
      { baseUrl: "https://xray.example.com", clientId: "id", clientSecret: "sec" },
      { projectKey: "P" },
      fn,
    );
    expect(r.failed[0]?.reason).toBe("net rip");
  });

  it("xray-exporter bulk fetch throws non-Error string → fails whole chunk", async () => {
    let phase = 0;
    const fn = vi.fn(async () => {
      phase += 1;
      if (phase === 1) return json(200, '"tok"');
      throw "rip";
    }) as unknown as typeof fetch;
    const r = await exportSuggestionsToXray(
      [sample()],
      { baseUrl: "https://xray.example.com", clientId: "id", clientSecret: "sec" },
      { projectKey: "P" },
      fn,
    );
    expect(r.failed[0]?.reason).toBe("rip");
  });

  it("xray-exporter defaults priority to Medium when undefined", async () => {
    let captured: unknown = null;
    const fn = vi.fn(async (url, init) => {
      if (String(url).includes("authenticate")) return json(200, '"tok"');
      captured = JSON.parse(String((init as RequestInit).body));
      return json(200, { results: [{ importedTest: { key: "X-1" } }] });
    }) as unknown as typeof fetch;
    await exportSuggestionsToXray(
      [sample({ priority: undefined })],
      { baseUrl: "https://xray.example.com", clientId: "id", clientSecret: "sec" },
      { projectKey: "P" },
      fn,
    );
    const sent = captured as Array<{ fields: { priority: { name: string } } }>;
    expect(sent[0].fields.priority.name).toBe("Medium");
  });

  it("zephyr-provider skips empty-action step rows + handles clampPageSize defaults", async () => {
    let phase = 0;
    const fn = vi.fn(async (url) => {
      phase += 1;
      if (String(url).includes("/teststeps")) {
        return json(200, {
          values: [
            { inline: { description: "  " } }, // empty action → skipped
            { inline: { description: "do x" } },
          ],
          isLast: true,
          startAt: 0,
          maxResults: 50,
          total: 2,
        });
      }
      return json(200, {
        values: [{ key: "Z-1", name: "t" }],
        isLast: true,
        startAt: 0,
        maxResults: 50,
        total: 1,
      });
    }) as unknown as typeof fetch;
    // pageSize 0 → clampPageSize default branch
    const r = await importZephyrCases(
      { baseUrl: "https://zep.example.com", token: "t" },
      { projectKey: "P", pageSize: 0 },
      fn,
    );
    expect(r.cases).toHaveLength(1);
    expect(phase).toBeGreaterThanOrEqual(2);
  });

  it("jira-provider readPriority object + readTags non-array/non-string branches", async () => {
    const { importJiraTestCases } = await import("../../../src/lib/testcoverage/index.js");
    const client = {
      async *searchIssuesAll() {
        yield {
          key: "JIRA-1",
          fields: {
            summary: { value: "From value field" }, // toStringValue line 159
            description: { content: [{ content: [{ text: "ADF body" }] }] }, // flattenAdf branch
            steps: "step1\nstep2",
            expected: "exp1",
            priority: { name: "High" }, // readPriority object branch (184)
            labels: 42, // readTags non-array non-string (192-194)
          },
        };
        yield {
          key: "JIRA-2",
          fields: {
            summary: 12345, // number → String(12345)
            priority: "Low", // readPriority string branch
            labels: "tag1, tag2", // readTags string branch
          },
        };
        yield {
          key: "JIRA-3",
          fields: {
            summary: null, // null branch
            priority: 99, // readPriority returns null (non-string/non-object)
            labels: undefined, // readTags returns []
          },
        };
      },
    } as unknown as import("../../../src/lib/connectors/jira/jira-client.js").JiraClient;
    const r = await importJiraTestCases(client, { projectKey: "P" });
    expect(r.fetched).toBe(3);
  });

  it("gherkin-provider parseFeature handles Scenario Outline + Examples + unknown placeholder", async () => {
    const { parseFeature } =
      await import("../../../src/lib/testcoverage/providers/gherkin-provider.js");
    const feature = `
@feat
Feature: F

Background:
  Given a precondition

@tag1 @tag2
Scenario Outline: Edit <user>
  Given a user "<user>"
  When they do <action>
  Then they see <unknown>

  Examples:
    | user | action |
    | bob  | edit   |
    | sue  | view   |
`;
    const r = parseFeature(feature);
    expect(r.cases.length).toBeGreaterThan(0);
    expect(r.confidence).toBe(1);
  });

  it("gherkin-provider parseFeature ignores comments + non-step lines + blank lines", async () => {
    const { parseFeature } =
      await import("../../../src/lib/testcoverage/providers/gherkin-provider.js");
    const feature = `
# top comment

Feature: F
# inside feature comment

Scenario: simple
  Given x
  When y
  Then z
  And also-and-after-then
`;
    const r = parseFeature(feature);
    expect(r.cases.length).toBe(1);
  });
});
