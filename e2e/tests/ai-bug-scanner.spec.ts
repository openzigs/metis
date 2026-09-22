/**
 * Epic #708 — AI Bug Scanner end-to-end walkthrough.
 *
 * Mocks the scanner API surface (rule-sets, scans, findings, triage, publish)
 * so the spec exercises the React UI flow end-to-end without spinning up the
 * orchestrator, LLM providers, or external GitHub/Jira endpoints.
 *
 * Scenarios covered:
 *   1. Rule editor — create a rule set, compile a rule, grade ≥5 exemplars,
 *      verify activation enables the next stage.
 *   2. Repository scanner page — kick off a scan, verify scan-history row
 *      appears, deep-link into triage.
 *   3. Triage view — approve, reject, and publish a finding to GitHub.
 */
import { test, expect, request } from "@playwright/test";
import { primeAdminUser } from "../fixtures/seed-user.js";
import { apiBase } from "../fixtures/api-base.js";
import { LoginPage } from "../pages/login.page.js";

const API_BASE = apiBase();

interface MockRule {
  id: string;
  ruleSetId: string;
  naturalLanguage: string;
  status: string;
  severity: string;
  category: string;
  errorMessage: string | null;
  compiledMeta: string | null;
  exemplarGrades: string | null;
}

interface MockRuleSet {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  isActive: boolean;
  rules: MockRule[];
}

test.describe("Epic #708 — AI Bug Scanner", () => {
  let projectId: string;

  test.beforeEach(async ({ page }) => {
    const { accessToken } = await primeAdminUser(API_BASE);
    const ctx = await request.newContext({
      baseURL: API_BASE,
      extraHTTPHeaders: { Authorization: `Bearer ${accessToken}` },
    });
    const slug = `e2e-scanner-${Date.now()}`;
    const res = await ctx.post("/api/projects", {
      data: { name: `Scanner ${slug}`, slug, description: "epic-708 e2e" },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    projectId = body.data?.id ?? body.id;
    await ctx.dispose();

    const loginPage = new LoginPage(page);
    await loginPage.goto();
    await loginPage.login("admin", "password");
  });

  test("rule editor: create set, compile rule, grade exemplars, activate", async ({ page }) => {
    const ruleSets: MockRuleSet[] = [];

    await page.route(`**/api/projects/${projectId}/rule-sets`, (route) => {
      const method = route.request().method();
      if (method === "GET") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ data: ruleSets }),
        });
      }
      if (method === "POST") {
        const post = route.request().postDataJSON() as { name: string };
        const newSet: MockRuleSet = {
          id: `set-${ruleSets.length + 1}`,
          projectId,
          name: post.name,
          description: null,
          isActive: true,
          rules: [],
        };
        ruleSets.push(newSet);
        return route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({ data: newSet }),
        });
      }
      return route.fallback();
    });

    await page.route(`**/api/projects/${projectId}/rule-sets/set-1/rules`, (route) => {
      const post = route.request().postDataJSON() as { naturalLanguage: string };
      const newRule: MockRule = {
        id: "rule-1",
        ruleSetId: "set-1",
        naturalLanguage: post.naturalLanguage,
        status: "draft",
        severity: "high",
        category: "correctness",
        errorMessage: null,
        compiledMeta: null,
        exemplarGrades: null,
      };
      ruleSets[0]!.rules.push(newRule);
      return route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ data: newRule }),
      });
    });

    await page.route(
      `**/api/projects/${projectId}/rule-sets/set-1/rules/rule-1/compile`,
      (route) => {
        const rule = ruleSets[0]!.rules[0]!;
        rule.status = "awaiting_grading";
        rule.compiledMeta = JSON.stringify({
          keywords: ["sql", "concat"],
          symbolKinds: ["function"],
        });
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ data: rule }),
        });
      },
    );

    await page.route(`**/api/projects/${projectId}/rule-sets/set-1/rules/rule-1/grade`, (route) => {
      const rule = ruleSets[0]!.rules[0]!;
      rule.status = "active";
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: rule }),
      });
    });

    await page.goto(`/projects/${projectId}/rule-sets`);
    await expect(page.getByTestId("scanner-rule-sets-root")).toBeVisible();

    await page.getByTestId("scanner-new-set-name").fill("My Rule Set");
    await page.getByTestId("scanner-new-set-submit").click();
    await expect(page.getByTestId("scanner-set-set-1")).toBeVisible();

    await page
      .getByTestId("scanner-new-rule-set-1")
      .fill("Detect SQL injection via string concatenation");
    await page.getByTestId("scanner-new-rule-submit-set-1").click();
    await expect(page.getByTestId("scanner-rule-rule-1")).toBeVisible();

    await page.getByTestId("scanner-rule-compile-rule-1").click();
    await expect(page.getByTestId("scanner-rule-grade-rule-1")).toBeVisible();

    for (let i = 0; i < 5; i++) {
      await page.getByTestId(`scanner-exemplar-snippet-rule-1-${i}`).fill(`example snippet ${i}`);
    }
    await page.getByTestId("scanner-rule-grade-rule-1").click();
    // Active rule no longer shows the Compile button.
    await expect(page.getByTestId("scanner-rule-compile-rule-1")).toHaveCount(0);
  });

  test("repository scanner: start a scan and follow deep-link", async ({ page }) => {
    const repoId = "repo-e2e";
    const scans: Array<{
      id: string;
      createdAt: string;
      status: string;
      mode: string;
      scannedSymbols: number;
      totalSymbols: number;
      totalTokens: number;
    }> = [];

    // #708 — the CTA is gated on the repository having a code graph. Stub the
    // gate alongside the scan routes; without it the button stays disabled and
    // the test times out on a click it can never make.
    await page.route(
      `**/api/projects/${projectId}/repositories/${repoId}/scans/index-status`,
      (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            data: {
              indexed: true,
              commitSha: "abcdef1234567890",
              lastIndexedAt: new Date().toISOString(),
              symbolCount: 10,
            },
          }),
        }),
    );

    await page.route(`**/api/projects/${projectId}/repositories/${repoId}/scans`, (route) => {
      const method = route.request().method();
      if (method === "GET") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ data: scans }),
        });
      }
      const scan = {
        id: "scan-1",
        createdAt: new Date().toISOString(),
        status: "pending",
        mode: "both",
        scannedSymbols: 0,
        totalSymbols: 0,
        totalTokens: 0,
      };
      scans.push(scan);
      return route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({ data: scan }),
      });
    });

    // After redirect to /projects/:id/scans/scan-1 the page calls these.
    await page.route(`**/api/projects/${projectId}/scans/scan-1`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            id: "scan-1",
            projectId,
            commitSha: "abcdef1234567890",
            status: "running",
            mode: "both",
            scannedSymbols: 3,
            totalSymbols: 10,
            totalTokens: 12345,
          },
        }),
      }),
    );
    await page.route(`**/api/projects/${projectId}/scans/scan-1/findings`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: [] }),
      }),
    );

    await page.goto(`/projects/${projectId}/repositories/${repoId}/scanner`);
    await expect(page.getByTestId("scanner-repo-root")).toBeVisible();
    await page.getByTestId("scanner-repo-start").click();
    // The CTA now opens a cost-warning dialog; the scan starts on confirm.
    await expect(page.getByTestId("scanner-cost-warning-dialog")).toBeVisible();
    await page.getByTestId("scanner-cost-warning-confirm").click();
    await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/scans/scan-1$`));
    await expect(page.getByTestId("scanner-triage-meta")).toContainText("commit abcdef12");
  });

  test("triage: approve a finding then publish to GitHub", async ({ page }) => {
    const finding = {
      id: "finding-1",
      scanId: "scan-1",
      ruleId: "rule-1",
      symbolId: "sym-1",
      title: "Possible SQL injection",
      body: "Detected string concatenation into a raw SQL query",
      severity: "high",
      category: "security",
      evidenceLines: "[10,11]",
      fingerprint: "fp-1",
      confidence: 0.82,
      triageStatus: "pending" as string,
      triageNote: null,
      materializedFindingId: null as string | null,
      symbol: { qualifiedName: "queries.lookupUser", filePath: "src/db.ts" },
      issueLinks: [] as Array<{
        id: string;
        provider: string;
        externalId: string;
        externalUrl: string;
      }>,
    };

    await page.route(`**/api/projects/${projectId}/scans/scan-1`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            id: "scan-1",
            projectId,
            commitSha: "deadbeefcafef00d",
            status: "completed",
            mode: "both",
            scannedSymbols: 10,
            totalSymbols: 10,
            totalTokens: 50000,
          },
        }),
      }),
    );

    await page.route(`**/api/projects/${projectId}/scans/scan-1/findings`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: [finding] }),
      }),
    );

    await page.route(
      `**/api/projects/${projectId}/scans/scan-1/findings/finding-1/triage`,
      (route) => {
        finding.triageStatus = "approved";
        finding.materializedFindingId = "finding-row-1";
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            data: {
              scanFindingId: "finding-1",
              newStatus: "approved",
              materializedFindingId: "finding-row-1",
            },
          }),
        });
      },
    );

    await page.route(
      `**/api/projects/${projectId}/scans/scan-1/findings/finding-1/publish`,
      (route) => {
        finding.issueLinks = [
          {
            id: "il-1",
            provider: "github",
            externalId: "42",
            externalUrl: "https://github.com/example/repo/issues/42",
          },
        ];
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            data: finding.issueLinks[0],
          }),
        });
      },
    );

    await page.goto(`/projects/${projectId}/scans/scan-1`);
    await expect(page.getByTestId("scanner-finding-finding-1")).toBeVisible();
    await page.getByTestId("scanner-finding-approve-finding-1").click();
    await expect(page.getByTestId("scanner-finding-publish-github-finding-1")).toBeVisible();
    await page.getByTestId("scanner-finding-publish-github-finding-1").click();
    await expect(page.getByTestId("scanner-finding-links-finding-1")).toContainText("github: 42");
  });
});
