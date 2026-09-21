/**
 * Azure DevOps Boards importer — WIQL id resolution, batch hydration,
 * hierarchy parent links, PAT basic auth.
 */
import { describe, expect, it, vi } from "vitest";
import { AzureDevopsImporter } from "../src/lib/importers/azure-devops-importer.js";
import type { ExternalIssue } from "../src/lib/importers/types.js";

function res(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => h.get(k.toLowerCase()) ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const noGuard = () => undefined;
const fast = { sleep: async () => undefined, now: () => 0, random: () => 0 };
const filter = { organization: "org", project: "proj" };

describe("AzureDevopsImporter", () => {
  it("count() runs the WIQL query and counts ids", async () => {
    const fetchFn = vi.fn(async () => res(200, { workItems: [{ id: 1 }, { id: 2 }] }));
    const imp = new AzureDevopsImporter({
      token: "pat",
      fetchFn,
      assertHostAllowed: noGuard,
      backoff: fast,
    });
    expect(await imp.count(filter)).toBe(2);
    const [url, init] = fetchFn.mock.calls[0];
    expect(String(url)).toContain("/_apis/wit/wiql");
    expect((init as RequestInit).method).toBe("POST");
    const auth = (init as RequestInit).headers as Record<string, string>;
    expect(auth.Authorization).toBe(`Basic ${Buffer.from(":pat").toString("base64")}`);
  });

  it("fetchAll hydrates work items and surfaces parent links", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(res(200, { workItems: [{ id: 10 }, { id: 11 }] }))
      .mockResolvedValueOnce(
        res(200, {
          value: [
            {
              id: 10,
              fields: { "System.Title": "Parent", "System.WorkItemType": "Epic" },
              relations: [],
            },
            {
              id: 11,
              fields: {
                "System.Title": "Child",
                "Microsoft.VSTS.Common.Priority": 1,
                "System.Tags": "alpha; beta",
              },
              relations: [
                {
                  rel: "System.LinkTypes.Hierarchy-Reverse",
                  url: "https://dev.azure.com/org/_apis/wit/workItems/10",
                },
              ],
            },
          ],
        }),
      );
    const imp = new AzureDevopsImporter({
      token: "pat",
      fetchFn,
      assertHostAllowed: noGuard,
      backoff: fast,
    });
    const out: ExternalIssue[] = [];
    for await (const i of imp.fetchAll(filter)) out.push(i);
    expect(out.map((i) => i.externalId)).toEqual(["10", "11"]);
    expect(out[1].parentExternalId).toBe("10");
    expect(out[1].labels).toEqual(["alpha", "beta"]);
    expect(out[1].priority).toBe("critical");
  });

  it("uses a custom WIQL when provided and honours baseUrl", async () => {
    const fetchFn = vi.fn(async () => res(200, { workItems: [] }));
    const imp = new AzureDevopsImporter({
      token: "pat",
      baseUrl: "https://ado.corp.local",
      fetchFn,
      assertHostAllowed: noGuard,
      backoff: fast,
    });
    await imp.count({ ...filter, wiql: "SELECT [System.Id] FROM workitems" });
    const init = fetchFn.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ query: "SELECT [System.Id] FROM workitems" });
    expect(String(fetchFn.mock.calls[0][0])).toContain("https://ado.corp.local");
  });

  it("map() applies default normalisation", () => {
    const imp = new AzureDevopsImporter({ token: "pat" });
    const mapped = imp.map({
      externalId: "1",
      externalSource: "azure-devops",
      url: "u",
      title: "T",
      body: "b",
      labels: [],
      type: "Bug",
    });
    expect(mapped.type).toBe("bug");
  });
});
