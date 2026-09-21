/**
 * Jira REST API client unit tests — Epic #556 / Issue #559.
 */
import { describe, expect, it, vi } from "vitest";
import {
  createJiraClient,
  createMockJiraClient,
  JiraApiError,
} from "../src/lib/connectors/jira/jira-client.js";
import type { JiraClientConfig } from "../src/lib/connectors/jira/types.js";

const CLOUD_CONFIG: JiraClientConfig = {
  edition: "cloud",
  baseUrl: "https://test.atlassian.net",
  username: "user@example.com",
  apiToken: "test-token-123",
};

const DC_CONFIG: JiraClientConfig = {
  edition: "datacenter",
  baseUrl: "https://jira.corp.net",
  username: "svc-account",
  apiToken: "pat-token-456",
};

function mockFetch(responses: Array<{ status: number; body: unknown }>): typeof fetch {
  let callIdx = 0;
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
    const resp = responses[callIdx] ?? responses[responses.length - 1];
    callIdx++;
    return new Response(resp.status === 204 ? null : JSON.stringify(resp.body), {
      status: resp.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

describe("createJiraClient — Cloud edition", () => {
  it("uses Basic auth for Cloud", async () => {
    const fetchFn = mockFetch([
      {
        status: 200,
        body: {
          version: "1001.0.0",
          baseUrl: "https://test.atlassian.net",
          deploymentType: "Cloud",
        },
      },
    ]);
    const client = createJiraClient(CLOUD_CONFIG, fetchFn);
    await client.getServerInfo();

    const call = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
    const headers = call[1].headers as Record<string, string>;
    expect(headers.Authorization).toMatch(/^Basic /);
    const decoded = Buffer.from(headers.Authorization.replace("Basic ", ""), "base64").toString();
    expect(decoded).toBe("user@example.com:test-token-123");
  });

  it("uses /rest/api/3 prefix for Cloud search", async () => {
    const fetchFn = mockFetch([
      {
        status: 200,
        body: {
          startAt: 0,
          maxResults: 20,
          total: 1,
          issues: [{ id: "1", key: "TEST-1", self: "u", fields: {} }],
        },
      },
    ]);
    const client = createJiraClient(CLOUD_CONFIG, fetchFn);
    await client.searchIssues("project=TEST");

    const call = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(call[0])).toContain("/rest/api/3/search");
  });

  it("testConnection returns server info + latency", async () => {
    const fetchFn = mockFetch([
      {
        status: 200,
        body: {
          version: "1001.0.0",
          baseUrl: "https://test.atlassian.net",
          serverTitle: "Jira Cloud",
        },
      },
    ]);
    const client = createJiraClient(CLOUD_CONFIG, fetchFn);
    const result = await client.testConnection();

    expect(result.ok).toBe(true);
    expect(result.serverInfo.version).toBe("1001.0.0");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("listProjects maps response", async () => {
    const fetchFn = mockFetch([
      {
        status: 200,
        body: [
          {
            id: "10000",
            key: "PROJ",
            name: "My Project",
            projectTypeKey: "software",
            avatarUrls: { "48x48": "https://img.png" },
          },
          { id: "10001", key: "OPS", name: "Operations", projectTypeKey: "business" },
        ],
      },
    ]);
    const client = createJiraClient(CLOUD_CONFIG, fetchFn);
    const projects = await client.listProjects();

    expect(projects).toHaveLength(2);
    expect(projects[0].key).toBe("PROJ");
    expect(projects[0].avatarUrl).toBe("https://img.png");
    expect(projects[1].avatarUrl).toBeUndefined();
  });

  it("getIssue fetches with expand params", async () => {
    const fetchFn = mockFetch([
      { status: 200, body: { id: "10001", key: "TEST-1", self: "u", fields: { summary: "Test" } } },
    ]);
    const client = createJiraClient(CLOUD_CONFIG, fetchFn);
    const issue = await client.getIssue("TEST-1", ["renderedFields"]);

    const call = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(call[0])).toContain("expand=renderedFields");
    expect(issue.key).toBe("TEST-1");
  });

  it("createIssue sends POST with fields", async () => {
    const fetchFn = mockFetch([
      { status: 201, body: { id: "10002", key: "TEST-2", self: "u", fields: {} } },
    ]);
    const client = createJiraClient(CLOUD_CONFIG, fetchFn);
    const issue = await client.createIssue({
      project: { key: "TEST" },
      summary: "New issue",
      issuetype: { name: "Task" },
    });

    expect(issue.key).toBe("TEST-2");
    const call = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[1].method).toBe("POST");
  });

  it("throws JiraApiError on non-2xx", async () => {
    const fetchFn = mockFetch([{ status: 401, body: { message: "Unauthorized" } }]);
    const client = createJiraClient(CLOUD_CONFIG, fetchFn);
    await expect(client.testConnection()).rejects.toThrow(JiraApiError);
    await expect(client.testConnection()).rejects.toMatchObject({ status: 401 });
  });
});

describe("createJiraClient — DC edition", () => {
  it("uses Bearer auth for Data Center", async () => {
    const fetchFn = mockFetch([
      { status: 200, body: { version: "9.12.0", baseUrl: "https://jira.corp.net" } },
    ]);
    const client = createJiraClient(DC_CONFIG, fetchFn);
    await client.getServerInfo();

    const call = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
    const headers = call[1].headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer pat-token-456");
  });

  it("uses /rest/api/2 prefix for DC search", async () => {
    const fetchFn = mockFetch([
      { status: 200, body: { startAt: 0, maxResults: 20, total: 0, issues: [] } },
    ]);
    const client = createJiraClient(DC_CONFIG, fetchFn);
    await client.searchIssues("project=OPS");

    const call = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(call[0])).toContain("/rest/api/2/search");
  });
});

describe("searchIssuesAll — async generator pagination", () => {
  it("paginates through all results", async () => {
    const allIssues = Array.from({ length: 5 }, (_, i) => ({
      id: String(i),
      key: `TEST-${i + 1}`,
      self: "u",
      fields: {},
    }));
    let callIdx = 0;
    const fetchFn = vi.fn(async () => {
      const startAt = callIdx * 2;
      const page = allIssues.slice(startAt, startAt + 2);
      callIdx++;
      return new Response(JSON.stringify({ startAt, maxResults: 2, total: 5, issues: page }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const client = createJiraClient(CLOUD_CONFIG, fetchFn);
    const collected: unknown[] = [];
    for await (const issue of client.searchIssuesAll("project=TEST", { maxResults: 2 })) {
      collected.push(issue);
    }

    expect(collected).toHaveLength(5);
    expect(fetchFn).toHaveBeenCalledTimes(3); // pages: 0-1, 2-3, 4
  });
});

describe("createMockJiraClient", () => {
  it("returns mock data", async () => {
    const mock = createMockJiraClient({
      projects: [{ id: "1", key: "MOCK", name: "Mock", projectTypeKey: "software" }],
      issues: [{ id: "1", key: "MOCK-1", self: "u", fields: { summary: "Mock issue" } }],
      issueDetails: {
        "MOCK-1": { id: "1", key: "MOCK-1", self: "u", fields: { summary: "Mock issue" } },
      },
    });

    expect(await mock.listProjects()).toHaveLength(1);
    const result = await mock.searchIssues("project=MOCK");
    expect(result.total).toBe(1);
    const detail = await mock.getIssue("MOCK-1");
    expect(detail.key).toBe("MOCK-1");
  });

  it("throws when shouldFail is set", async () => {
    const mock = createMockJiraClient({
      shouldFail: { status: 500, message: "Server error" },
    });

    await expect(mock.testConnection()).rejects.toThrow(JiraApiError);
    await expect(mock.listProjects()).rejects.toThrow(JiraApiError);
  });

  it("searchIssuesAll yields all mock issues", async () => {
    const mock = createMockJiraClient({
      issues: [
        { id: "1", key: "A-1", self: "u", fields: {} },
        { id: "2", key: "A-2", self: "u", fields: {} },
      ],
    });
    const collected: unknown[] = [];
    for await (const issue of mock.searchIssuesAll("project=A")) {
      collected.push(issue);
    }
    expect(collected).toHaveLength(2);
  });
});

// ---- fetchRaw wiring (#1054) ------------------------------------------------

describe("createJiraClient — fetchRaw credential scoping (#1054)", () => {
  const rawDeps = {
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    dispatcherFactory: async () => ({ close: async () => undefined }),
  };

  function rawFetch(calls: Array<{ url: string; headers: Record<string, string> }>): typeof fetch {
    return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(url),
        headers: { ...((init?.headers ?? {}) as Record<string, string>) },
      });
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(Buffer.from("bytes")));
            controller.close();
          },
        }),
        { status: 200, headers: { "content-type": "image/png" } },
      );
    }) as unknown as typeof fetch;
  }

  it("attaches the Cloud Basic credential to a same-origin attachment", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const client = createJiraClient(CLOUD_CONFIG, rawFetch(calls), rawDeps);
    const res = await client.fetchRaw("https://test.atlassian.net/secure/attachment/1/a.png");
    expect(calls).toHaveLength(1);
    expect(calls[0].headers.Authorization).toMatch(/^Basic /);
    expect(res.contentType).toBe("image/png");
    expect(res.contentDisposition).toBe("inline");
  });

  it("attaches the Data Center Bearer credential to a same-origin attachment", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const client = createJiraClient(DC_CONFIG, rawFetch(calls), rawDeps);
    await client.fetchRaw("https://jira.corp.net/secure/attachment/1/a.png");
    expect(calls[0].headers.Authorization).toBe("Bearer pat-token-456");
  });

  it("refuses the prefix-bypass host that the old startsWith() check allowed", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const client = createJiraClient(CLOUD_CONFIG, rawFetch(calls), rawDeps);
    await expect(
      client.fetchRaw("https://test.atlassian.net.attacker.com/collect"),
    ).rejects.toThrow(JiraApiError);
    expect(calls).toHaveLength(0);
  });

  it("the mock client still satisfies the fetchRaw contract", async () => {
    const mock = createMockJiraClient();
    const res = await mock.fetchRaw("https://jira.example.com/secure/attachment/1/a.bin");
    expect(res.contentDisposition).toBe("attachment");
    expect(res.contentLength).toBe(12);
    const reader = res.body.getReader();
    const first = await reader.read();
    expect(Buffer.from(first.value!).toString()).toBe("mock-content");
  });
});
