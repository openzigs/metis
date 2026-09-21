/**
 * Importer factory dispatch + token-requirement helper.
 */
import { describe, expect, it } from "vitest";
import { createImporter, sourceUsesToken } from "../src/lib/importers/registry.js";
import { GithubImporter } from "../src/lib/importers/github-importer.js";
import { AzureDevopsImporter } from "../src/lib/importers/azure-devops-importer.js";
import { LinearImporter } from "../src/lib/importers/linear-importer.js";
import { JiraImporter } from "../src/lib/importers/jira-importer.js";

const deps = { fetchFn: async () => new Response("{}"), assertHostAllowed: () => undefined };

describe("createImporter", () => {
  it("returns a GithubImporter for github", () => {
    expect(createImporter({ source: "github", token: "t" }, deps)).toBeInstanceOf(GithubImporter);
  });

  it("returns an AzureDevopsImporter for azure-devops", () => {
    expect(createImporter({ source: "azure-devops", token: "t" }, deps)).toBeInstanceOf(
      AzureDevopsImporter,
    );
  });

  it("returns a LinearImporter for linear", () => {
    expect(createImporter({ source: "linear", token: "t" }, deps)).toBeInstanceOf(LinearImporter);
  });

  it("returns a JiraImporter for jira", () => {
    const imp = createImporter(
      {
        source: "jira",
        client: { searchIssues: async () => ({ startAt: 0, maxResults: 0, total: 0, issues: [] }) },
        baseUrl: "https://jira",
      },
      deps,
    );
    expect(imp).toBeInstanceOf(JiraImporter);
  });
});

describe("sourceUsesToken", () => {
  it("is true for token-based sources and false for jira", () => {
    expect(sourceUsesToken("github")).toBe(true);
    expect(sourceUsesToken("azure-devops")).toBe(true);
    expect(sourceUsesToken("linear")).toBe(true);
    expect(sourceUsesToken("jira")).toBe(false);
  });
});
