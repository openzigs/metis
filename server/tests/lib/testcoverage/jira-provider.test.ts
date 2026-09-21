/**
 * Jira provider tests — issue #873.
 */
import { describe, expect, it } from "vitest";

import { importJiraTestCases } from "../../../src/lib/testcoverage/index.js";
import { createMockJiraClient } from "../../../src/lib/connectors/jira/jira-client.js";

describe("importJiraTestCases", () => {
  it("imports issues with parallel step/expected lines and labels", async () => {
    const client = createMockJiraClient({
      issues: [
        {
          id: "10001",
          key: "PROJ-1",
          self: "https://j.example.com/rest/api/2/issue/10001",
          fields: {
            summary: "Login",
            description: "user must exist",
            steps: "open page\nenter creds\nsubmit",
            expected: "form shown\nvalues set\nlogged in",
            priority: { name: "High" },
            labels: ["smoke", "ui"],
            issuetype: { id: "1", name: "Test", subtask: false },
          },
        },
      ],
    });

    const r = await importJiraTestCases(client, { projectKey: "PROJ" });
    expect(r.fetched).toBe(1);
    expect(r.cases).toHaveLength(1);
    expect(r.cases[0].externalId).toBe("PROJ-1");
    expect(r.cases[0].title).toBe("Login");
    expect(r.cases[0].preconditions).toBe("user must exist");
    expect(r.cases[0].priority).toBe("high");
    expect(r.cases[0].tags).toContain("smoke");
    expect(r.cases[0].steps).toHaveLength(3);
    expect(r.cases[0].steps[0].action).toBe("open page");
    expect(r.cases[0].steps[0].expected).toBe("form shown");
    expect(r.cases[0].steps[2].expected).toBe("logged in");
  });

  it("uses configurable field mapping when provided", async () => {
    const client = createMockJiraClient({
      issues: [
        {
          id: "10002",
          key: "PROJ-2",
          self: "https://j.example.com/rest/api/2/issue/10002",
          fields: {
            summary: "Wrong",
            customfield_10001: "Real Title",
            customfield_10002: "step a\nstep b",
            issuetype: { id: "1", name: "Test", subtask: false },
          },
        },
      ],
    });
    const r = await importJiraTestCases(client, {
      projectKey: "PROJ",
      fieldMapping: { titleField: "customfield_10001", stepsField: "customfield_10002" },
    });
    expect(r.cases[0].title).toBe("Real Title");
    expect(r.cases[0].steps).toHaveLength(2);
  });

  it("flattens Atlassian Document Format rich-text fields", async () => {
    const adf = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Hello" }] },
        { type: "paragraph", content: [{ type: "text", text: "World" }] },
      ],
    };
    const client = createMockJiraClient({
      issues: [
        {
          id: "10003",
          key: "PROJ-3",
          self: "x",
          fields: {
            summary: "ADF title",
            description: adf as unknown as string,
            issuetype: { id: "1", name: "Test", subtask: false },
          },
        },
      ],
    });
    const r = await importJiraTestCases(client, { projectKey: "PROJ" });
    expect(r.cases[0].preconditions).toContain("Hello");
    expect(r.cases[0].preconditions).toContain("World");
  });

  it("returns empty when client iterator yields nothing", async () => {
    const client = createMockJiraClient({ issues: [] });
    const r = await importJiraTestCases(client, { projectKey: "PROJ" });
    expect(r.fetched).toBe(0);
    expect(r.cases).toEqual([]);
  });
});
