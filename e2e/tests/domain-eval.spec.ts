/**
 * Epic #803 (Epic 09) — Domain Eval leaderboard tab (#807) end-to-end coverage.
 *
 * The Domain Eval tab on `/eval/leaderboard` is file-backed by the nightly
 * BA-pipeline regression runner. To keep these tests deterministic (and not
 * dependent on a nightly cron having committed `eval-results/*.json`), the
 * read API (`GET /eval/domain/runs` and `/runs/:id`) is intercepted with a
 * hand-built golden corpus — see `fixtures/domain-eval-fixture.ts`. The mock
 * payloads mirror the REAL server envelope, including the detail `{ run }`
 * wrapper, so the UI is exercised exactly as it is in production.
 *
 * Acceptance criteria mapped (epic #803 + sub-issue #807):
 *   AC1 — Opening the Domain Eval tab and drilling into a corpus item shows
 *         the expected-vs-actual extraction with a per-field diff.
 *   AC2 — The tab renders an F1 trend chart (SVG), a runs table with drift
 *         badges, and a per-corpus-item drill-in detail (calibration +
 *         per-item field diff).
 *   AC3 — The expected-vs-actual side-by-side per-field diff is visible when
 *         drilling into a corpus item (changed fields are flagged; matched,
 *         missed, and hallucinated requirements are all represented).
 */
import { test, expect } from "@playwright/test";
import { LoginPage } from "../pages/login.page.js";
import { DomainEvalPage } from "../pages/domain-eval.page.js";
import {
  mockDomainEvalApi,
  RUN_DRIFT_ID,
  RUN_IMPROVED_ID,
  RUN_HEALTHY_ID,
  ITEM_AUTH_ID,
  ITEM_CHECKOUT_ID,
} from "../fixtures/domain-eval-fixture.js";

test.describe("Epic #803 — Domain Eval leaderboard tab", () => {
  let domain: DomainEvalPage;

  test.beforeEach(async ({ page }) => {
    // Sign in through the browser so the (authed) shell renders the page.
    const login = new LoginPage(page);
    await login.loginAsAdmin();

    // Intercept the Domain Eval read API before the tab mounts and fetches.
    await mockDomainEvalApi(page);

    domain = new DomainEvalPage(page);
    await domain.goto();
  });

  test("Domain Eval - tab activates and renders the panel", async () => {
    await test.step("switch to the Domain Eval tab", async () => {
      await expect(domain.domainTab).toBeVisible();
      await domain.openDomainTab();
    });

    await test.step("panel header and run table are present", async () => {
      await expect(domain.heading).toBeVisible();
      await expect(domain.runsTable).toBeVisible();
    });
  });

  // AC2: "The tab shows an F1 trend chart (SVG)…"
  test("Domain Eval - renders the F1 trend chart with a drift-flagged point", async () => {
    await domain.openDomainTab();

    await test.step("the SVG trend chart is visible", async () => {
      await expect(domain.trendCard).toBeVisible();
      await expect(domain.trendChart).toBeVisible();
      // Empty-state copy must NOT appear when ≥2 runs exist.
      await expect(domain.trendEmpty).toBeHidden();
    });

    await test.step("the regressed run is plotted as a drift point", async () => {
      await expect(domain.trendPoint(RUN_DRIFT_ID)).toHaveAttribute("data-drift-alert", "true");
      await expect(domain.trendPoint(RUN_HEALTHY_ID)).toHaveAttribute("data-drift-alert", "false");
    });
  });

  // AC2: "…a runs table with drift badges…"
  test("Domain Eval - runs table lists every run and badges the drifted run", async () => {
    await domain.openDomainTab();

    await test.step("all three runs appear as rows", async () => {
      await expect(domain.runRow(RUN_DRIFT_ID)).toBeVisible();
      await expect(domain.runRow(RUN_IMPROVED_ID)).toBeVisible();
      await expect(domain.runRow(RUN_HEALTHY_ID)).toBeVisible();
    });

    await test.step("only the regressed run carries a Drift badge", async () => {
      await expect(domain.driftBadge(RUN_DRIFT_ID)).toBeVisible();
      await expect(domain.driftBadge(RUN_DRIFT_ID)).toHaveText("Drift");
      // Healthy runs render an "OK" cell, never a drift badge.
      await expect(domain.driftBadge(RUN_HEALTHY_ID)).toHaveCount(0);
      await expect(domain.runRow(RUN_HEALTHY_ID)).toContainText("OK");
    });
  });

  // AC1 + AC2: drill-in detail with calibration.
  test("Domain Eval - drilling into a run reveals the confidence calibration", async () => {
    await domain.openDomainTab();

    await test.step("inspect the regressed run", async () => {
      await domain.inspectRun(RUN_DRIFT_ID);
    });

    await test.step("calibration bins with data are shown; empty bins are hidden", async () => {
      await expect(domain.calibration()).toBeVisible();
      await expect(domain.calibrationBin("0.4–0.5")).toBeVisible();
      await expect(domain.calibrationBin("0.8–0.9")).toBeVisible();
      await expect(domain.calibrationBin("0.9–1.0")).toBeVisible();
      // The zero-count bucket is filtered out by the panel.
      await expect(domain.calibrationBin("0.0–0.1")).toHaveCount(0);
    });

    await test.step("the detail view can be closed", async () => {
      await domain.closeDetail();
      await expect(domain.runDetail(RUN_DRIFT_ID)).toHaveCount(0);
    });
  });

  // AC1 + AC3: pick a corpus item → expected vs actual per-field diff.
  test("Domain Eval - expanding a corpus item shows the expected-vs-actual field diff", async () => {
    await domain.openDomainTab();
    await domain.inspectRun(RUN_DRIFT_ID);

    await test.step("the corpus item is listed in the drill-in", async () => {
      await expect(domain.itemRow(ITEM_AUTH_ID)).toBeVisible();
    });

    await test.step("expanding the item reveals its field diff", async () => {
      await domain.expandItem(ITEM_AUTH_ID);
      await expect(domain.fieldDiff(ITEM_AUTH_ID)).toBeVisible();
    });

    await test.step("the matched requirement shows side-by-side expected vs predicted", async () => {
      const matchRow = domain.diffRow(ITEM_AUTH_ID, 0);
      await expect(matchRow).toHaveAttribute("data-kind", "match");
      // Title is identical → not flagged as differing.
      await expect(matchRow.locator('[data-field="title"]')).toHaveAttribute(
        "data-differs",
        "false",
      );
      // Priority changed high → medium, so the field is flagged and both
      // values are rendered side by side.
      const priorityRow = matchRow.locator('[data-field="priority"]');
      await expect(priorityRow).toHaveAttribute("data-differs", "true");
      await expect(priorityRow).toContainText("high");
      await expect(priorityRow).toContainText("medium");
    });
  });

  // AC3: matched, missed (false negative) and hallucinated (false positive)
  // requirements are all represented in the per-field diff.
  test("Domain Eval - field diff distinguishes matched, missed and hallucinated requirements", async () => {
    await domain.openDomainTab();
    await domain.inspectRun(RUN_DRIFT_ID);
    await domain.expandItem(ITEM_AUTH_ID);

    await test.step("exactly one row of each alignment kind is rendered", async () => {
      await expect(domain.diffRowsByKind(ITEM_AUTH_ID, "match")).toHaveCount(1);
      await expect(domain.diffRowsByKind(ITEM_AUTH_ID, "missed")).toHaveCount(1);
      await expect(domain.diffRowsByKind(ITEM_AUTH_ID, "hallucinated")).toHaveCount(1);
    });

    await test.step("the missed requirement shows the golden text with no prediction", async () => {
      const missed = domain.diffRowsByKind(ITEM_AUTH_ID, "missed");
      await expect(missed).toContainText("Missed (false negative)");
      await expect(missed.locator('[data-field="title"]')).toContainText("Password reset");
    });

    await test.step("the hallucinated requirement shows the extra prediction", async () => {
      const extra = domain.diffRowsByKind(ITEM_AUTH_ID, "hallucinated");
      await expect(extra).toContainText("Extra (false positive)");
      await expect(extra.locator('[data-field="title"]')).toContainText("Rate limiting");
    });
  });

  // AC1: a second, fully-matched corpus item drills in cleanly (happy path).
  test("Domain Eval - a fully-matched corpus item drills in without diff noise", async () => {
    await domain.openDomainTab();
    await domain.inspectRun(RUN_DRIFT_ID);
    await domain.expandItem(ITEM_CHECKOUT_ID);

    await test.step("the single matched row reports no missed or hallucinated items", async () => {
      await expect(domain.diffRowsByKind(ITEM_CHECKOUT_ID, "match")).toHaveCount(1);
      await expect(domain.diffRowsByKind(ITEM_CHECKOUT_ID, "missed")).toHaveCount(0);
      await expect(domain.diffRowsByKind(ITEM_CHECKOUT_ID, "hallucinated")).toHaveCount(0);
    });
  });

  test("Domain Eval - empty state is shown when no runs exist", async ({ page }) => {
    // Re-stub with an empty run list for this scenario only.
    await mockDomainEvalApi(page, { runs: [] });
    await domain.openDomainTab();

    await expect(domain.runsEmpty).toBeVisible();
    await expect(domain.trendEmpty).toBeVisible();
  });
});
