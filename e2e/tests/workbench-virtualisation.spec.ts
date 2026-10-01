/**
 * Issue #584 — the Workbench Documents panel's virtualised list (#526), in a
 * real browser.
 *
 * The unit suite cannot show either property checked here: jsdom has no
 * layout, and `ui/tests/virtualizer-stub.ts` makes `measureElement` a no-op.
 *
 *   AC1: with thousands of documents, the panel mounts only a small window of
 *        rows wherever it is scrolled to — which holds only if its own scroll
 *        container is height-bounded inside the page's layout (otherwise the
 *        outer wrapper scrolls and every row mounts) — and the mounted rows
 *        tile the list with no overlap and no gap, which holds only if each
 *        row is measured (`ref={virtualizer.measureElement}`), since a row's
 *        real height differs from its estimate.
 *   AC2: dragging the divider between the Documents and Chat panes changes
 *        the Documents pane's width, and the new width survives a reload.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect, request, type Page } from "@playwright/test";
import { ADMIN_USER, primeAdminUser } from "../fixtures/seed-user.js";
import { seedDocumentsBulkViaCli } from "../fixtures/seed-helpers.js";
import { LoginPage } from "../pages/login.page.js";
import { WorkbenchPage } from "../pages/workbench.page.js";
import { apiBase } from "../fixtures/api-base.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const API_BASE = apiBase();

/** Documents seeded into the project: far more than any viewport holds. */
const DOC_COUNT = 3000;
/** The issue's bound on mounted rows; a viewport plus overscan is a few dozen. */
const MAX_MOUNTED = 100;

function dbUrl(): string {
  return `file:${
    process.env.E2E_DB_FILE ??
    path.join(__dirname, "..", "test-results", "stack-data", "metis-e2e.db")
  }`;
}

interface RowLayout {
  /** How many tree rows are mounted. */
  mounted: number;
  /** Lowest and highest mounted row index. */
  firstIndex: number;
  lastIndex: number;
  /** Adjacent mounted rows whose edges do not meet, as `index: gap px`. */
  seams: string[];
  /** Do the mounted rows cover the scroll container's visible height? */
  coversViewport: boolean;
}

/**
 * Read the mounted rows' geometry. Adjacent rows (by `data-index`) must meet
 * exactly: a positive gap means a row was placed for a taller estimate than it
 * has, a negative one means it overlaps its neighbour.
 */
async function readRowLayout(page: Page): Promise<RowLayout> {
  return page.getByTestId("workbench-doc-scroll").evaluate((scroller) => {
    const rows = Array.from(scroller.querySelectorAll<HTMLElement>('[role="treeitem"]'))
      .map((el) => ({ index: Number(el.dataset.index), rect: el.getBoundingClientRect() }))
      .sort((a, b) => a.index - b.index);
    const seams: string[] = [];
    for (let i = 1; i < rows.length; i++) {
      const prev = rows[i - 1];
      const next = rows[i];
      if (next.index !== prev.index + 1) continue;
      const gap = next.rect.top - prev.rect.bottom;
      if (Math.abs(gap) > 1) seams.push(`${next.index}: ${gap.toFixed(1)}px`);
    }
    const box = scroller.getBoundingClientRect();
    const first = rows[0];
    const last = rows[rows.length - 1];
    return {
      mounted: rows.length,
      firstIndex: first?.index ?? -1,
      lastIndex: last?.index ?? -1,
      seams,
      coversViewport:
        rows.length > 0 && first.rect.top <= box.top + 1 && last.rect.bottom >= box.bottom - 1,
    };
  });
}

test.describe("Workbench virtualised document list (#584)", () => {
  // Seeding thousands of rows and paging them into the browser takes a while.
  test.describe.configure({ timeout: 180_000 });

  let projectName: string;

  test.beforeEach(async ({ page }) => {
    const primed = await primeAdminUser(API_BASE);
    const slug = `e2e-wb-virt-${Date.now()}`;
    projectName = `WB Virtualised ${slug}`;
    const api = await request.newContext({
      baseURL: API_BASE,
      extraHTTPHeaders: { Authorization: `Bearer ${primed.accessToken}` },
    });
    const res = await api.post("/api/projects", {
      data: { name: projectName, slug, description: "workbench virtualisation e2e" },
    });
    expect(res.status()).toBe(201);
    const body = (await res.json()) as {
      id?: string;
      data?: { id?: string; project?: { id?: string } };
    };
    const projectId = (body.data?.project?.id ?? body.data?.id ?? body.id) as string;
    expect(projectId).toBeTruthy();
    await api.dispose();

    const created = seedDocumentsBulkViaCli({
      projectId,
      uploadedById: primed.userId,
      count: DOC_COUNT,
      databaseUrl: dbUrl(),
    });
    expect(created).toBe(DOC_COUNT);

    const loginPage = new LoginPage(page);
    await loginPage.goto();
    await loginPage.login(ADMIN_USER.username, ADMIN_USER.password);
  });

  /** The document rows (the group headings are level 1). */
  function fileRows(wb: WorkbenchPage) {
    return wb.docScroll.locator('[role="treeitem"][aria-level="2"]');
  }

  async function openProject(page: Page): Promise<WorkbenchPage> {
    const wb = new WorkbenchPage(page);
    await wb.goto();
    // The picker auto-selects the first project once the list loads; wait for
    // that before choosing ours, or the auto-select overwrites the choice.
    await expect(wb.projectPicker).not.toHaveValue("", { timeout: 15_000 });
    await wb.selectProject(projectName);
    // Every document is loaded (a file row's set size is the group's size)
    // before anything is measured.
    await expect(fileRows(wb).first()).toHaveAttribute("aria-setsize", String(DOC_COUNT), {
      timeout: 60_000,
    });
    return wb;
  }

  // AC1 — a small, gap-free window of rows wherever the list is scrolled to.
  test("mounts only the rows in view while scrolling thousands of documents", async ({ page }) => {
    const wb = await openProject(page);

    const bounds = await wb.docScroll.evaluate((el) => ({
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
      viewport: window.innerHeight,
    }));
    await test.step("the panel's own scroll container is height-bounded", async () => {
      // Bounded: shorter than the window, and it — not the page — holds the
      // overflow (the full list is thousands of rows tall).
      expect(bounds.clientHeight).toBeGreaterThan(0);
      expect(bounds.clientHeight).toBeLessThan(bounds.viewport);
      expect(bounds.scrollHeight).toBeGreaterThan(bounds.clientHeight * 20);
    });

    for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
      await test.step(`scrolled to ${fraction * 100}%`, async () => {
        // The list's height is read afresh at each step: the virtualiser
        // replaces each row's estimate with its measured height as it mounts,
        // so the total grows while scrolling.
        await wb.docScroll.evaluate((el, f) => {
          el.scrollTop = Math.round((el.scrollHeight - el.clientHeight) * f);
        }, fraction);
        // Wait for the virtualiser to render the rows at the new offset.
        await expect
          .poll(async () => (await readRowLayout(page)).coversViewport, { timeout: 10_000 })
          .toBe(true);
        const layout = await readRowLayout(page);
        expect(layout.mounted).toBeGreaterThan(0);
        expect(layout.mounted).toBeLessThan(MAX_MOUNTED);
        expect(layout.seams, "adjacent rows must meet: no overlap, no gap").toEqual([]);
        if (fraction > 0) expect(layout.firstIndex).toBeGreaterThan(0);
        // At the bottom the last document is mounted and in view.
        if (fraction === 1) {
          // Measuring the rows near the end can grow the list once more; keep
          // following the bottom until the last document is the last row.
          const last = fileRows(wb).last();
          await expect
            .poll(
              async () => {
                await wb.docScroll.evaluate((el) => {
                  el.scrollTop = el.scrollHeight;
                });
                return last.getAttribute("aria-posinset");
              },
              { timeout: 10_000 },
            )
            .toBe(String(DOC_COUNT));
          expect((await readRowLayout(page)).seams).toEqual([]);
          await expect(last).toBeInViewport();
        }
      });
    }

    await test.step("the page itself never scrolled", async () => {
      expect(await page.evaluate(() => document.scrollingElement?.scrollTop ?? 0)).toBe(0);
    });
  });

  // AC2 — the divider resizes the Documents pane, and the width persists.
  test("dragging the documents divider resizes the pane and persists across reload", async ({
    page,
  }) => {
    const wb = await openProject(page);

    const before = await wb.leftPanel.boundingBox();
    const valueBefore = Number(await wb.leftSeparator.getAttribute("aria-valuenow"));
    const handle = await wb.leftSeparator.boundingBox();
    expect(before).not.toBeNull();
    expect(handle).not.toBeNull();
    if (!before || !handle) return;

    await test.step("drag the divider 160px to the right", async () => {
      const x = handle.x + handle.width / 2;
      const y = handle.y + handle.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + 80, y, { steps: 5 });
      await page.mouse.move(x + 160, y, { steps: 5 });
      await page.mouse.up();
    });

    let widthAfter = 0;
    let valueAfter = 0;
    await test.step("the Documents pane is wider", async () => {
      await expect
        .poll(async () => (await wb.leftPanel.boundingBox())?.width ?? 0)
        .toBeGreaterThan(before.width + 100);
      widthAfter = (await wb.leftPanel.boundingBox())?.width ?? 0;
      valueAfter = Number(await wb.leftSeparator.getAttribute("aria-valuenow"));
      expect(valueAfter).toBeGreaterThan(valueBefore);
    });

    await test.step("the width survives a reload", async () => {
      await page.reload({ waitUntil: "load" });
      await expect(wb.heading).toBeVisible();
      await expect(wb.leftSeparator).toHaveAttribute("aria-valuenow", String(valueAfter));
      await expect
        .poll(async () => Math.abs(((await wb.leftPanel.boundingBox())?.width ?? 0) - widthAfter))
        .toBeLessThan(2);
    });
  });
});
