/**
 * Jira importer — JQL pagination, custom field remap, ADF serialisation.
 */
import { describe, expect, it, vi } from "vitest";
import { JiraImporter, type JiraSearchClient } from "../src/lib/importers/jira-importer.js";
import type { JiraSearchResult } from "@metis/shared";

function result(
  issues: Array<{ id?: string; key: string; self?: string; fields: Record<string, unknown> }>,
  total: number,
  startAt = 0,
): JiraSearchResult {
  return {
    startAt,
    maxResults: 100,
    total,
    issues: issues.map((i) => ({
      id: i.id ?? i.key,
      key: i.key,
      self: i.self ?? "",
      fields: i.fields,
    })),
  } as JiraSearchResult;
}

describe("JiraImporter", () => {
  it("count() requests maxResults:0 and returns total", async () => {
    const searchIssues = vi.fn(async () => result([], 7));
    const client: JiraSearchClient = { searchIssues };
    const imp = new JiraImporter({ client, baseUrl: "https://jira.example.com" });
    expect(await imp.count({ connectionId: "c", jql: "project=X" })).toBe(7);
    expect(searchIssues).toHaveBeenCalledWith("project=X", { startAt: 0, maxResults: 0 });
  });

  it("fetchAll paginates until total is reached", async () => {
    const searchIssues = vi
      .fn()
      .mockResolvedValueOnce(
        result([{ key: "X-1", fields: { summary: "One", issuetype: { name: "Bug" } } }], 2),
      )
      .mockResolvedValueOnce(
        result([{ key: "X-2", fields: { summary: "Two", priority: { name: "High" } } }], 2, 1),
      );
    const imp = new JiraImporter({
      client: { searchIssues },
      baseUrl: "https://jira.example.com/",
    });
    const keys: string[] = [];
    for await (const i of imp.fetchAll({ connectionId: "c", jql: "project=X" }))
      keys.push(i.externalId);
    expect(keys).toEqual(["X-1", "X-2"]);
    expect(searchIssues).toHaveBeenCalledTimes(2);
  });

  it("builds a browse URL and maps issuetype/priority", async () => {
    const searchIssues = vi.fn(async () =>
      result(
        [
          {
            key: "X-9",
            fields: { summary: "S", issuetype: { name: "Bug" }, priority: { name: "Highest" } },
          },
        ],
        1,
      ),
    );
    const imp = new JiraImporter({ client: { searchIssues }, baseUrl: "https://jira.example.com" });
    const issues = [];
    for await (const i of imp.fetchAll({ connectionId: "c", jql: "x" })) issues.push(i);
    expect(issues[0].url).toBe("https://jira.example.com/browse/X-9");
    const mapped = imp.map(issues[0]);
    expect(mapped.type).toBe("bug");
    expect(mapped.priority).toBe("critical");
  });

  it("applies a custom field map and serialises ADF bodies", async () => {
    const searchIssues = vi.fn(async () =>
      result(
        [
          {
            key: "X-1",
            fields: {
              summary: "ignored",
              custom_title: "Real Title",
              custom_body: { text: "Rich body" },
            },
          },
        ],
        1,
      ),
    );
    const imp = new JiraImporter({
      client: { searchIssues },
      baseUrl: "https://jira.example.com",
      customFieldMap: { title: "custom_title", body: "custom_body" },
    });
    const issues = [];
    for await (const i of imp.fetchAll({ connectionId: "c", jql: "x" })) issues.push(i);
    expect(issues[0].title).toBe("Real Title");
    expect(issues[0].body).toBe("Rich body");
  });

  it("stops when a page returns no issues", async () => {
    const searchIssues = vi.fn(async () => result([], 5));
    const imp = new JiraImporter({ client: { searchIssues }, baseUrl: "https://jira.example.com" });
    const issues = [];
    for await (const i of imp.fetchAll({ connectionId: "c", jql: "x" })) issues.push(i);
    expect(issues).toHaveLength(0);
  });

  it("serialises {name} objects and falls back to JSON for opaque fields", async () => {
    const searchIssues = vi.fn(async () =>
      result([{ key: "X-1", fields: { summary: { name: "Named" }, description: { foo: 1 } } }], 1),
    );
    const imp = new JiraImporter({ client: { searchIssues }, baseUrl: "https://jira.example.com" });
    const issues = [];
    for await (const i of imp.fetchAll({ connectionId: "c", jql: "x" })) issues.push(i);
    expect(issues[0].title).toBe("Named");
    expect(issues[0].body).toBe(JSON.stringify({ foo: 1 }));
  });
});
