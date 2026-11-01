/**
 * #1629 — portfolio gap and impact analysis, as a business analyst walks it
 * (epic #1608; acceptance criteria of #1626 and #1627).
 *
 *   1. A requirement product A covers: the answer names A and its repo, and B
 *      is listed as not covering it.
 *   2. A requirement nothing covers: "Nothing in your portfolio covers this",
 *      with both products listed.
 *   3. A requirement A covers only in part: A must change, B is downstream
 *      through the shared database at severity high, and the export downloads.
 *   4. A second user, outside B's workspace, opens that check: B is restricted,
 *      with nothing about it shown.
 *
 * The portfolio is `fixtures/portfolio.ts`: two products in two workspaces,
 * three repos (uploaded as `.zip` archives built from that file, and indexed
 * by the real ingest), one contract edge and one shared-table edge, declared
 * through the #1620 API. Nothing reaches the network.
 *
 * The model's answers are committed replay fixtures (`fixtures/llm`), recorded
 * from `fixtures/portfolio-record-book.json`; a call they do not cover falls
 * back to the offline stub, which the BA report does (it is then the template,
 * and says so). To re-record after a prompt or a fixture repo changes:
 *
 *   AI_REPLAY=0 AI_RECORD=1 AI_OFFLINE_SCRIPT_FILE=e2e/fixtures/portfolio-record-book.json \
 *     pnpm --filter @metis/e2e test portfolio-gap-impact
 *
 * then keep only the new fixtures whose prompt starts `<<<REQUIREMENT>>>`.
 *
 * "All products I can access" checks every product the analyst can read, so
 * the products other specs left behind (an unbound product is visible to every
 * user) would be in scope and stop a gap from ever being confirmed. The seed
 * therefore removes every product the analyst can see that it did not create.
 */
import { readFile } from "node:fs/promises";
import { test, expect, request, type APIRequestContext, type Page } from "@playwright/test";
import { io } from "socket.io-client";
import { apiBase } from "../fixtures/api-base.js";
import { ADMIN_USER } from "../fixtures/seed-user.js";
import {
  PAYMENTS_API,
  PAYMENTS_DB,
  PORTFOLIO,
  REPORTING_SERVICE,
  STATEMENTS,
  type PortfolioRepo,
} from "../fixtures/portfolio.js";
import { buildZip } from "../fixtures/zip.js";
import { LoginPage } from "../pages/login.page.js";
import { PortfolioCheckPage, PortfolioEntryPage } from "../pages/portfolio.page.js";

const API_BASE = apiBase();
const ANALYST = { username: "coordinator", password: "password" };
/** In "Portfolio A" only: cannot read Reporting or its repo. */
const OUTSIDER = { username: "developer", password: "password", email: "developer@metis.local" };

interface Envelope<T> {
  data: T;
}

interface Session {
  api: APIRequestContext;
  token: string;
  userId: string;
}

async function signIn(username: string, password: string): Promise<Session> {
  const anon = await request.newContext({ baseURL: API_BASE });
  const res = await anon.post("/api/auth/login", { data: { username, password } });
  expect(res.status(), `login ${username}: ${await res.text()}`).toBe(200);
  const body = (await res.json()) as Envelope<{ accessToken: string; user: { id: string } }>;
  await anon.dispose();
  return {
    token: body.data.accessToken,
    userId: body.data.user.id,
    api: await request.newContext({
      baseURL: API_BASE,
      extraHTTPHeaders: { Authorization: `Bearer ${body.data.accessToken}` },
    }),
  };
}

async function created<T>(
  res: Awaited<ReturnType<APIRequestContext["post"]>>,
  what: string,
): Promise<T> {
  expect([200, 201], `${what}: ${await res.text()}`).toContain(res.status());
  return ((await res.json()) as Envelope<T>).data;
}

/** Follow a job's lifecycle until it ends; the server replays the last transition on subscribe. */
function jobEnd(token: string, jobId: string, timeoutMs = 120_000) {
  return new Promise<{ status: string; error?: string; message?: string }>((resolve, reject) => {
    const socket = io(API_BASE, { path: "/socket.io", transports: ["websocket"], auth: { token } });
    const finish = (fn: () => void) => {
      clearTimeout(timer);
      socket.disconnect();
      fn();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error(`job ${jobId} did not end within ${timeoutMs}ms`))),
      timeoutMs,
    );
    socket.on("job:lifecycle", (e: { jobId: string; status: string; error?: string }) => {
      if (e.jobId !== jobId) return;
      if (e.status === "completed" || e.status === "failed") finish(() => resolve(e));
    });
    socket.once("connect", () => socket.emit("subscribe:job", { jobId }));
    socket.once("connect_error", (err) => finish(() => reject(err)));
  });
}

/**
 * Upload `repo` as a `.zip` connector in `projectId` and index it. A project's
 * first connector starts an ingest of its own and holds the ingest lease, so
 * the deep ingest is retried while the route answers `INGEST_IN_PROGRESS`.
 */
async function uploadAndIndex(s: Session, projectId: string, repo: PortfolioRepo): Promise<string> {
  const upload = await s.api.post(`/api/projects/${projectId}/connectors/repos/upload`, {
    multipart: {
      label: repo.label,
      file: {
        name: `${repo.label}.zip`,
        mimeType: "application/zip",
        buffer: buildZip(repo.files),
      },
    },
  });
  const { id } = await created<{ id: string }>(upload, `upload ${repo.label}`);
  const url = `/api/projects/${projectId}/connectors/repos/${id}/deep-ingest`;
  const deadline = Date.now() + 90_000;
  for (;;) {
    const res = await s.api.post(url);
    if (res.status() === 202) {
      const { jobId } = ((await res.json()) as Envelope<{ jobId: string }>).data;
      const end = await jobEnd(s.token, jobId);
      expect(end.status, `ingest ${repo.label}: ${end.error ?? end.message}`).toBe("completed");
      return id;
    }
    const text = await res.text();
    if (!(res.status() === 409 && text.includes("INGEST_IN_PROGRESS")) || Date.now() > deadline) {
      throw new Error(`deep-ingest ${repo.label} answered ${res.status()}: ${text}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

interface Seeded {
  payments: string;
  reporting: string;
}

/** Build the synthetic portfolio of `fixtures/portfolio.ts` through the API. */
async function seedPortfolio(): Promise<Seeded> {
  const stamp = `${Date.now()}`;
  let analyst = await signIn(ANALYST.username, ANALYST.password);
  const outsider = await signIn(OUTSIDER.username, OUTSIDER.password);
  const admin = await signIn(ADMIN_USER.username, ADMIN_USER.password);
  try {
    const workspace = async (name: string, slug: string) =>
      (
        await created<{ id: string }>(
          await analyst.api.post("/api/workspaces", { data: { name, slug } }),
          `workspace ${name}`,
        )
      ).id;
    const wsA = await workspace(PORTFOLIO.workspaces.a, `portfolio-a-${stamp}`);
    const wsB = await workspace(PORTFOLIO.workspaces.b, `portfolio-b-${stamp}`);

    // The outsider joins "Portfolio A" only.
    const invite = await created<{ token: string }>(
      await analyst.api.post(`/api/workspaces/${wsA}/invites`, {
        data: { email: OUTSIDER.email, role: "member" },
      }),
      "invite the outsider",
    );
    await created(
      await outsider.api.post(`/api/workspaces/invites/${invite.token}/accept`),
      "the outsider accepts",
    );

    // A fresh token carries the analyst's new workspaces.
    await analyst.api.dispose();
    analyst = await signIn(ANALYST.username, ANALYST.password);

    const project = async (slug: string, workspaceId: string) =>
      (
        await created<{ id: string }>(
          await analyst.api.post("/api/projects", {
            data: {
              name: `${slug} (${stamp})`,
              slug: `${slug}-${stamp}`,
              description: "E2E #1629: synthetic portfolio",
              workspaceId,
            },
          }),
          `project ${slug}`,
        )
      ).id;
    const repos = {
      api: await uploadAndIndex(analyst, await project("payments-api", wsA), PAYMENTS_API),
      db: await uploadAndIndex(analyst, await project("payments-db", wsA), PAYMENTS_DB),
      reporting: await uploadAndIndex(
        analyst,
        await project("reporting-service", wsB),
        REPORTING_SERVICE,
      ),
    };

    const product = async (name: string, repoIds: string[]) => {
      const { id } = await created<{ id: string }>(
        await analyst.api.post("/api/products", {
          data: { name, slug: `${name.toLowerCase()}-${stamp}`, description: "E2E #1629" },
        }),
        `product ${name}`,
      );
      // The first repo attached homes the product in that repo's workspace (#1527).
      for (const repoConnectionId of repoIds) {
        await created(
          await analyst.api.post(`/api/products/${id}/repos`, { data: { repoConnectionId } }),
          `attach a repo to ${name}`,
        );
      }
      return id;
    };
    const payments = await product(PORTFOLIO.products.payments, [
      repos.api,
      repos.db,
      repos.reporting,
    ]);
    const reporting = await product(PORTFOLIO.products.reporting, [repos.reporting]);

    const table = await created<{ id: string }>(
      await analyst.api.post(`/api/products/${payments}/resources`, {
        data: { kind: "table", name: PORTFOLIO.table },
      }),
      "the shared table",
    );
    await created(
      await analyst.api.post(`/api/products/${payments}/edges`, {
        data: {
          sourceRepoId: repos.reporting,
          targetRepoId: repos.api,
          edgeType: "calls",
          integrationKind: "api",
          strength: "contract",
          direction: "consumes",
        },
      }),
      "the contract edge",
    );
    await created(
      await analyst.api.post(`/api/products/${payments}/edges`, {
        data: {
          sourceRepoId: repos.db,
          targetRepoId: repos.reporting,
          resourceId: table.id,
          edgeType: "produces",
          integrationKind: "database",
          strength: "intrusive",
          direction: "writes",
        },
      }),
      "the shared-table edge",
    );

    // Only these two products may be in the analyst's portfolio (see the header).
    // Each round removes the first page of leftovers, until none is left.
    for (let round = 0; ; round += 1) {
      const res = await analyst.api.get("/api/products", { params: { pageSize: 100 } });
      expect(res.status(), `list products: ${await res.text()}`).toBe(200);
      const { items } = ((await res.json()) as Envelope<{ items: Array<{ id: string }> }>).data;
      const leftovers = items.filter((p) => p.id !== payments && p.id !== reporting);
      if (leftovers.length === 0) break;
      expect(round, "leftover products keep reappearing").toBeLessThan(50);
      for (const p of leftovers) {
        const del = await admin.api.delete(`/api/products/${p.id}`);
        expect([204, 404], `remove a leftover product: ${await del.text()}`).toContain(
          del.status(),
        );
      }
    }
    return { payments, reporting };
  } finally {
    await Promise.all([analyst.api.dispose(), outsider.api.dispose(), admin.api.dispose()]);
  }
}

async function signInPage(page: Page, user: { username: string; password: string }) {
  const login = new LoginPage(page);
  await login.goto();
  await login.login(user.username, user.password);
}

test.describe.serial("Portfolio gap and impact analysis (#1629)", () => {
  test.setTimeout(240_000);
  let partialCheckId: string;

  test.beforeAll(async () => {
    test.setTimeout(480_000);
    await seedPortfolio();
  });

  test("Journey 1 — a requirement Payments covers names it and its repo", async ({ page }) => {
    await signInPage(page, ANALYST);
    const entry = new PortfolioEntryPage(page);
    await entry.goto();
    await entry.checkAcrossPortfolio(STATEMENTS.covered);

    const check = new PortfolioCheckPage(page);
    await check.waitForAnswer("Covered by Payments (payments-api)");
    await expect(check.matrixRow("Payments")).toContainText("Covers it");
    await expect(check.matrixRow("Reporting")).toContainText("Does not cover it");
  });

  test("Journey 2 — a requirement nothing covers says so, and lists both products", async ({
    page,
  }) => {
    await signInPage(page, ANALYST);
    const entry = new PortfolioEntryPage(page);
    await entry.goto();
    await entry.checkAcrossPortfolio(STATEMENTS.uncovered);

    const check = new PortfolioCheckPage(page);
    await check.waitForAnswer("Nothing in your portfolio covers this");
    // A header row, then one row per product in scope.
    await expect(check.matrix.getByRole("rowheader")).toHaveCount(2);
    await expect(check.matrixRow("Payments")).toContainText("Does not cover it");
    await expect(check.matrixRow("Reporting")).toContainText("Does not cover it");
  });

  test("Journey 3 — Reporting is downstream through the shared database at high, and the export downloads", async ({
    page,
  }) => {
    await signInPage(page, ANALYST);
    const entry = new PortfolioEntryPage(page);
    await entry.goto();
    partialCheckId = await entry.checkAcrossPortfolio(STATEMENTS.partial);

    const check = new PortfolioCheckPage(page);
    await check.waitForAnswer("Partly covered by Payments (payments-api)");
    await expect(check.impactCard("Payments")).toContainText("Must change");
    const reporting = check.impactCard("Reporting");
    await expect(reporting).toContainText("Downstream consumer");
    await expect(reporting).toContainText("via a shared database");
    await expect(reporting).toContainText("Severity: high");

    const download = await check.exportMarkdown();
    expect(download.suggestedFilename()).toMatch(/\.md$/);
    const markdown = await readFile((await download.path())!, "utf8");
    expect(markdown).toContain("# Portfolio assessment");
    expect(markdown).toContain(STATEMENTS.partial);
    expect(markdown).toMatch(
      /\| Reporting \| Does not cover it \|.*\| Downstream consumer via database \| high \|/,
    );
  });

  test("Journey 4 — a user outside Reporting's workspace sees it restricted, with no detail", async ({
    page,
  }) => {
    expect(partialCheckId, "Journey 3 ran first and started the check").toBeTruthy();
    await signInPage(page, OUTSIDER);
    const check = new PortfolioCheckPage(page);
    await check.goto(partialCheckId);
    await check.waitForAnswer("Partly covered by Payments (payments-api)");

    const hidden = check.matrixRow("A product you cannot read");
    await expect(hidden).toContainText("Restricted");
    await expect(hidden.getByRole("button")).toHaveCount(0);
    await expect(check.matrixRow("Payments")).toContainText("Partly covers it");

    const card = check.impactCard("A product you cannot read");
    await expect(card).toContainText("Downstream consumer");
    await expect(card).not.toContainText("Severity");
    await expect(card).not.toContainText("via");
    await expect(card.getByRole("button")).toHaveCount(0);
    // Nothing on the page names it, or its repo.
    await expect(page.getByText(PORTFOLIO.products.reporting, { exact: true })).toHaveCount(0);
    await expect(page.getByText(REPORTING_SERVICE.label)).toHaveCount(0);
  });
});
