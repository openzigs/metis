/**
 * #2424 — one scope, picked the same way in chat, a new impact analysis and the
 * portfolio check (the shared picker of #2351), by a workspace member who is
 * not an admin (the mock `developer`), on desktop.
 *
 * | Acceptance criterion (#2424)                                              | Test                     |
 * |---------------------------------------------------------------------------|--------------------------|
 * | the same scope in chat, impact and portfolio: the label and the request   | Whole workspace; Chosen  |
 * | runs as a non-admin member; only readable products/projects are offered  | every test (the offers)  |
 * | the portfolio check refuses an unreadable product (404)                   | an unreadable product    |
 * | a desktop walkthrough as a non-admin, with screenshots                    | every test attaches them |
 *
 * The seed, through the API as the admin:
 *
 *   Workspace "Scope shared <run>"   (the member is in it)
 *     project Alpha <run>  ── repo ──  product Alpha <run>
 *     project Beta <run>   ── repo ──  product Beta <run>
 *   Workspace "Scope private <run>"  (the member is not)
 *     project Gamma <run>  ── repo ──  product Gamma <run>
 *
 * Each product holds its project's one repo, so it lives in that project's
 * workspace (#1527) and a member of the workspace can read it; projects and
 * products share their names, so "the same scope" reads the same in all three.
 * In chat and impact analysis a product is a project; in the portfolio check
 * it is a portfolio product (#2351's decision), so the ids sent differ while
 * the set is the same: Alpha and Beta.
 */
import {
  test,
  expect,
  request,
  type APIRequestContext,
  type Page,
  type TestInfo,
} from "@playwright/test";
import { apiBase } from "../fixtures/api-base.js";
import { ADMIN_USER } from "../fixtures/seed-user.js";
import { buildZip } from "../fixtures/zip.js";
import { LoginPage } from "../pages/login.page.js";
import { ScopePickerPage } from "../pages/scope-picker.page.js";

const API_BASE = apiBase();
/** The non-admin workspace member (`server/src/lib/auth/mock-provider.ts`). */
const MEMBER = { username: "developer", password: "password", email: "developer@metis.local" };
/** Base 36: a 13-digit stamp can read as a card number to the chat guardrail (#1446). */
const RUN = Date.now().toString(36);

const NAMES = {
  shared: `Scope shared ${RUN}`,
  private: `Scope private ${RUN}`,
  alpha: `Alpha ${RUN}`,
  beta: `Beta ${RUN}`,
  gamma: `Gamma ${RUN}`,
} as const;

interface Envelope<T> {
  data: T;
}

interface Seeded {
  workspace: string;
  privateWorkspace: string;
  projects: { alpha: string; beta: string; gamma: string };
  products: { alpha: string; beta: string; gamma: string };
}

async function signIn(username: string, password: string): Promise<APIRequestContext> {
  const anon = await request.newContext({ baseURL: API_BASE });
  const res = await anon.post("/api/auth/login", { data: { username, password } });
  expect(res.status(), `login ${username}: ${await res.text()}`).toBe(200);
  const { accessToken } = ((await res.json()) as Envelope<{ accessToken: string }>).data;
  await anon.dispose();
  return request.newContext({
    baseURL: API_BASE,
    extraHTTPHeaders: { Authorization: `Bearer ${accessToken}` },
  });
}

async function created<T>(
  res: Awaited<ReturnType<APIRequestContext["post"]>>,
  what: string,
): Promise<T> {
  expect([200, 201], `${what}: ${await res.text()}`).toContain(res.status());
  return ((await res.json()) as Envelope<T>).data;
}

/** Everything the seed made, removed by `afterAll` (products, then projects, then workspaces). */
const made = { products: [] as string[], projects: [] as string[], workspaces: [] as string[] };

async function seed(): Promise<Seeded> {
  const admin = await signIn(ADMIN_USER.username, ADMIN_USER.password);
  const member = await signIn(MEMBER.username, MEMBER.password);
  try {
    const workspace = async (name: string, slug: string) => {
      const { id } = await created<{ id: string }>(
        await admin.post("/api/workspaces", { data: { name, slug } }),
        `workspace ${name}`,
      );
      made.workspaces.push(id);
      return id;
    };
    const shared = await workspace(NAMES.shared, `scope-shared-${RUN}`);
    const priv = await workspace(NAMES.private, `scope-private-${RUN}`);

    const invite = await created<{ token: string }>(
      await admin.post(`/api/workspaces/${shared}/invites`, {
        data: { email: MEMBER.email, role: "member" },
      }),
      "invite the member",
    );
    await created(
      await member.post(`/api/workspaces/invites/${invite.token}/accept`),
      "the member accepts",
    );

    /** A project in `workspaceId` holding one uploaded repo, and a product of that repo. */
    const projectWithProduct = async (name: string, workspaceId: string) => {
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      const project = await created<{ id: string }>(
        await admin.post("/api/projects", {
          data: { name, slug, description: "E2E #2424: scope picker", workspaceId },
        }),
        `project ${name}`,
      );
      made.projects.push(project.id);
      const repo = await created<{ id: string }>(
        await admin.post(`/api/projects/${project.id}/connectors/repos/upload`, {
          multipart: {
            label: slug,
            file: {
              name: `${slug}.zip`,
              mimeType: "application/zip",
              buffer: buildZip([{ path: `${slug}/README.md`, content: `# ${name}\n` }]),
            },
          },
        }),
        `upload ${name}'s repo`,
      );
      const product = await created<{ id: string }>(
        await admin.post("/api/products", {
          data: { name, slug, description: "E2E #2424: scope picker" },
        }),
        `product ${name}`,
      );
      made.products.push(product.id);
      // The first repo attached homes the product in the repo's workspace (#1527).
      await created(
        await admin.post(`/api/products/${product.id}/repos`, {
          data: { repoConnectionId: repo.id },
        }),
        `attach ${name}'s repo`,
      );
      return { project: project.id, product: product.id };
    };
    const alpha = await projectWithProduct(NAMES.alpha, shared);
    const beta = await projectWithProduct(NAMES.beta, shared);
    const gamma = await projectWithProduct(NAMES.gamma, priv);
    return {
      workspace: shared,
      privateWorkspace: priv,
      projects: { alpha: alpha.project, beta: beta.project, gamma: gamma.project },
      products: { alpha: alpha.product, beta: beta.product, gamma: gamma.product },
    };
  } finally {
    await Promise.all([admin.dispose(), member.dispose()]);
  }
}

/** Best-effort, like workspaces.spec.ts: a failed delete is annotated, never a red run. */
async function cleanUp(testInfo: TestInfo): Promise<void> {
  const admin = await signIn(ADMIN_USER.username, ADMIN_USER.password);
  try {
    const remove = async (path: string) => {
      const outcome = await admin
        .delete(path)
        .then((res) => (res.ok() || res.status() === 404 ? null : `HTTP ${res.status()}`))
        .catch((err: unknown) => String(err));
      if (outcome)
        testInfo.annotations.push({ type: "cleanup", description: `${path}: ${outcome}` });
    };
    // Projects go before their workspaces: a deleted workspace leaves its live
    // projects in no workspace, which opens them to every user.
    for (const id of made.products.splice(0)) await remove(`/api/products/${id}`);
    for (const id of made.projects.splice(0)) await remove(`/api/projects/${id}`);
    for (const id of made.workspaces.splice(0)) await remove(`/api/workspaces/${id}`);
  } finally {
    await admin.dispose();
  }
}

/** Sign the member in with the shared workspace, and Alpha, open in the top bar. */
async function signInMember(page: Page, seeded: Seeded): Promise<void> {
  await page.addInitScript(
    ([workspaceId, projectId]) => {
      window.localStorage.setItem("metis.activeWorkspaceId", workspaceId);
      window.localStorage.setItem("metis.activeProjectId", projectId);
    },
    [seeded.workspace, seeded.projects.alpha] as const,
  );
  const login = new LoginPage(page);
  await login.goto();
  await login.login(MEMBER.username, MEMBER.password);
}

/** A desktop screenshot for the walkthrough (#2424), attached to the report. */
async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const path = testInfo.outputPath(`${name}.png`);
  // The whole page: an open picker can reach past the viewport.
  await page.screenshot({ path, fullPage: true });
  await testInfo.attach(name, { path, contentType: "image/png" });
}

/** The JSON body of the next POST to `pathname`, and its response's status and body. */
function nextPost(page: Page, pathname: RegExp) {
  return page
    .waitForResponse(
      (r) => r.request().method() === "POST" && pathname.test(new URL(r.url()).pathname),
      { timeout: 60_000 },
    )
    .then(async (res) => ({
      sent: res.request().postDataJSON() as Record<string, unknown>,
      status: res.status(),
      body: (await res.json().catch(() => null)) as Record<string, unknown> | null,
    }));
}

const sorted = (ids: unknown) => [...(ids as string[])].sort();

const WORKSPACE_LABEL = `Whole workspace: ${NAMES.shared} (2 products)`;
const CHOSEN_LABEL = `${NAMES.alpha} + ${NAMES.beta}`;

/** Only what the member can read is offered: Alpha and Beta, never Gamma. */
async function expectOffersReadableOnly(picker: ScopePickerPage): Promise<void> {
  await expect(picker.item(NAMES.alpha)).toBeVisible({ timeout: 30_000 });
  await expect(picker.item(NAMES.beta)).toBeVisible();
  await expect(picker.item(NAMES.gamma)).toHaveCount(0);
  await expect(picker.popover).not.toContainText(NAMES.gamma);
  await expect(picker.popover).not.toContainText(NAMES.private);
}

test.describe
  .serial("One scope in chat, impact and the portfolio check, as a member (#2424)", () => {
  test.setTimeout(180_000);
  let seeded: Seeded;

  test.beforeAll(async () => {
    test.setTimeout(240_000);
    seeded = await seed();
  });

  test.afterAll(async ({}, testInfo) => {
    await cleanUp(testInfo);
  });

  test("Whole workspace: the same words, and the same two products, in all three", async ({
    page,
  }, testInfo) => {
    await signInMember(page, seeded);

    await test.step("chat: the three options, and the workspace sent as one", async () => {
      await page.goto("/chat", { waitUntil: "load" });
      const picker = new ScopePickerPage(page, "Project scope");
      // The top bar's project opens the chat (#1139).
      await expect(picker.button).toHaveText(`This project: ${NAMES.alpha}`, { timeout: 30_000 });
      await picker.open();
      await expect(picker.thisProject).toHaveText(`This project: ${NAMES.alpha}`);
      await expect(picker.wholeWorkspace).toHaveText(WORKSPACE_LABEL, { timeout: 30_000 });
      await expectOffersReadableOnly(picker);
      await shot(page, testInfo, "01-chat-picker-options");

      await picker.wholeWorkspace.click();
      await expect(picker.button).toHaveText(WORKSPACE_LABEL);
      const post = nextPost(page, /\/api\/ai\/sessions$/);
      await page.getByLabel("Message").fill("Which of these products records invoices?");
      await page.getByRole("button", { name: "Send" }).click();
      const { sent, status, body } = await post;
      expect(status, JSON.stringify(body)).toBe(201);
      expect(sent.workspaceId).toBe(seeded.workspace);
      expect(sent.projectIds).toBeUndefined();
      expect(sent.projectId).toBeUndefined();
      const scope = (body!.data as { scope: { appliedWorkspaceId?: string; degraded: boolean } })
        .scope;
      expect(scope.appliedWorkspaceId).toBe(seeded.workspace);
      expect(scope.degraded).toBe(false);
      await shot(page, testInfo, "02-chat-whole-workspace-sent");
    });

    // What chat's workspace scope searches: the workspace's projects the member reads.
    const member = await signIn(MEMBER.username, MEMBER.password);
    try {
      const res = await member.get(`/api/projects?workspaceId=${seeded.workspace}&limit=100`);
      expect(res.status(), await res.text()).toBe(200);
      const { items } = ((await res.json()) as Envelope<{ items: Array<{ id: string }> }>).data;
      expect(sorted(items.map((p) => p.id))).toEqual(
        sorted([seeded.projects.alpha, seeded.projects.beta]),
      );
    } finally {
      await member.dispose();
    }

    await test.step("impact analysis: the same option, sending both projects", async () => {
      await page.goto("/impact-analyses/new", { waitUntil: "load" });
      const picker = new ScopePickerPage(page, "Projects to analyse");
      await page
        .getByLabel("Requirement change text")
        .fill("Invoices are paid by instant transfer.");
      await picker.open();
      // Opened from no project, "This project" is unavailable and says why.
      await expect(picker.thisProject).toBeDisabled();
      await expect(picker.popover).toContainText(
        "Open this from a project or a change request to start there.",
      );
      await expect(picker.wholeWorkspace).toHaveText(WORKSPACE_LABEL, { timeout: 30_000 });
      await expectOffersReadableOnly(picker);
      await shot(page, testInfo, "03-impact-picker-options");

      await picker.wholeWorkspace.click();
      await expect(picker.button).toHaveText(WORKSPACE_LABEL);
      await expect(page.getByText("2 selected", { exact: true })).toBeVisible();
      const post = nextPost(page, /\/api\/impact-analyses$/);
      await page.getByRole("button", { name: "Run impact analysis" }).click();
      const { sent, status, body } = await post;
      expect([200, 201, 202], JSON.stringify(body)).toContain(status);
      expect(sorted(sent.projectIds)).toEqual(
        sorted([seeded.projects.alpha, seeded.projects.beta]),
      );
      await expect(page).toHaveURL(/\/impact-analyses\/(?!new)[^/]+$/);
    });

    await test.step("portfolio check: the same option, sending both products", async () => {
      await page.goto("/portfolio", { waitUntil: "load" });
      const picker = new ScopePickerPage(page, "Products to check");
      await page.getByLabel("Requirement statement").fill("Invoices are paid by instant transfer.");
      // From elsewhere, nothing is chosen: every product the member can read.
      await expect(picker.button).toHaveText("Every product you can read");
      await picker.open();
      await expect(picker.thisProject).toBeDisabled();
      await expect(picker.wholeWorkspace).toHaveText(WORKSPACE_LABEL, { timeout: 30_000 });
      await picker.close();
      // The list is every product the member reads; find this run's by name.
      await page.getByLabel("Find products", { exact: true }).fill(RUN);
      await picker.open();
      await expectOffersReadableOnly(picker);
      await shot(page, testInfo, "04-portfolio-picker-options");

      await picker.wholeWorkspace.click();
      await expect(picker.button).toHaveText(WORKSPACE_LABEL);
      await expect(page.getByText("2 products to check.")).toBeVisible();
      const post = nextPost(page, /\/api\/portfolio-assessments$/);
      await page.getByRole("button", { name: "Check coverage" }).click();
      const { sent, status, body } = await post;
      expect([200, 201, 202], JSON.stringify(body)).toContain(status);
      expect(sent.scope).toBe("product");
      expect(sorted(sent.productIds)).toEqual(
        sorted([seeded.products.alpha, seeded.products.beta]),
      );
      await expect(page).toHaveURL(/\/portfolio\/[^/?]+$/);
    });
  });

  test("Chosen products: the same two ticked, named and sent, in all three", async ({
    page,
  }, testInfo) => {
    await signInMember(page, seeded);

    await test.step("chat: the top bar's project ticked, then another", async () => {
      await page.goto("/chat", { waitUntil: "load" });
      const picker = new ScopePickerPage(page, "Project scope");
      await expect(picker.button).toHaveText(`This project: ${NAMES.alpha}`, { timeout: 30_000 });
      // Alpha is the top bar's project: ticked, it stays ticked and Beta joins it.
      await picker.choose([NAMES.alpha, NAMES.beta]);
      await expect(picker.button).toHaveText(CHOSEN_LABEL);
      const post = nextPost(page, /\/api\/ai\/sessions$/);
      await page.getByLabel("Message").fill("Which of these products records invoices?");
      await page.getByRole("button", { name: "Send" }).click();
      const { sent, status, body } = await post;
      expect(status, JSON.stringify(body)).toBe(201);
      expect(sent.projectIds).toEqual([seeded.projects.alpha, seeded.projects.beta]);
      expect(sent.workspaceId).toBeUndefined();
      const scope = (body!.data as { scope: { appliedProjectIds?: string[]; degraded: boolean } })
        .scope;
      expect(sorted(scope.appliedProjectIds)).toEqual(
        sorted([seeded.projects.alpha, seeded.projects.beta]),
      );
      expect(scope.degraded).toBe(false);
      await shot(page, testInfo, "05-chat-chosen-sent");
    });

    await test.step("impact analysis: the same two", async () => {
      await page.goto("/impact-analyses/new", { waitUntil: "load" });
      const picker = new ScopePickerPage(page, "Projects to analyse");
      await page
        .getByLabel("Requirement change text")
        .fill("Invoices are paid by instant transfer.");
      await picker.choose([NAMES.alpha, NAMES.beta]);
      await expect(picker.button).toHaveText(CHOSEN_LABEL);
      await expect(page.getByText("2 selected", { exact: true })).toBeVisible();
      await shot(page, testInfo, "06-impact-chosen");
      const post = nextPost(page, /\/api\/impact-analyses$/);
      await page.getByRole("button", { name: "Run impact analysis" }).click();
      const { sent, status, body } = await post;
      expect([200, 201, 202], JSON.stringify(body)).toContain(status);
      expect(sent.projectIds).toEqual([seeded.projects.alpha, seeded.projects.beta]);
      await expect(page).toHaveURL(/\/impact-analyses\/(?!new)[^/]+$/);
    });

    await test.step("portfolio check: the same two", async () => {
      await page.goto("/portfolio", { waitUntil: "load" });
      const picker = new ScopePickerPage(page, "Products to check");
      await page.getByLabel("Requirement statement").fill("Invoices are paid by instant transfer.");
      await page.getByLabel("Find products", { exact: true }).fill(RUN);
      await picker.choose([NAMES.alpha, NAMES.beta]);
      await expect(picker.button).toHaveText(CHOSEN_LABEL);
      await expect(page.getByText("2 products to check.")).toBeVisible();
      await shot(page, testInfo, "07-portfolio-chosen");
      const post = nextPost(page, /\/api\/portfolio-assessments$/);
      await page.getByRole("button", { name: "Check coverage" }).click();
      const { sent, status, body } = await post;
      expect([200, 201, 202], JSON.stringify(body)).toContain(status);
      expect(sent.scope).toBe("product");
      expect(sent.productIds).toEqual([seeded.products.alpha, seeded.products.beta]);
      await expect(page).toHaveURL(/\/portfolio\/[^/?]+$/);
    });
  });

  test("an unreadable product is never offered, and the portfolio check refuses it (404)", async ({
    page,
  }, testInfo) => {
    await signInMember(page, seeded);

    await test.step("arriving with it, the check is refused and nothing starts", async () => {
      await page.goto(`/portfolio?productId=${seeded.products.gamma}`, { waitUntil: "load" });
      const picker = new ScopePickerPage(page, "Products to check");
      await page.getByLabel("Requirement statement").fill("Invoices are paid by instant transfer.");
      // Named only as "Selected product": the member cannot read its name.
      await expect(picker.button).toHaveText("Selected product", { timeout: 30_000 });
      await expect(page.getByRole("main")).not.toContainText(NAMES.gamma);
      const post = nextPost(page, /\/api\/portfolio-assessments$/);
      await page.getByRole("button", { name: "Check coverage" }).click();
      const { sent, status } = await post;
      expect(sent.productIds).toEqual([seeded.products.gamma]);
      expect(status).toBe(404);
      const form = page.getByRole("form", { name: "Check a requirement across your portfolio" });
      await expect(form.getByRole("alert")).toHaveText("Product not found");
      await expect(page).toHaveURL(/\/portfolio\?productId=/);
      await shot(page, testInfo, "08-portfolio-unreadable-refused");
    });

    await test.step("next to a readable one, it is refused all the same", async () => {
      const member = await signIn(MEMBER.username, MEMBER.password);
      try {
        const res = await member.post("/api/portfolio-assessments", {
          data: {
            statement: "Invoices are paid by instant transfer.",
            scope: "product",
            productIds: [seeded.products.alpha, seeded.products.gamma],
          },
        });
        expect(res.status(), await res.text()).toBe(404);
      } finally {
        await member.dispose();
      }
    });
  });
});
