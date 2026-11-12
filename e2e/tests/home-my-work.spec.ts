/**
 * #2348 — Home is "My work".
 *
 * | Criterion (#2348)                                                     | Test                                        |
 * |-----------------------------------------------------------------------|---------------------------------------------|
 * | an analyst with a waiting question sees it on Home, lands on Questions | analyst: waiting row opens the Questions tab |
 * | a non-admin's Home shows no Tasks, Runs or Scheduler widget            | analyst: waiting row opens the Questions tab |
 * | an admin keeps them, below "My work"                                   | admin: My work above the operations widgets |
 * | the server derives the user from the session                          | the endpoint answers the session user       |
 *
 * A change request waiting on answers needs a completed analysis run that
 * extracted clarifying questions, which the deterministic stack cannot produce
 * without a model, so the browser tests answer `GET /api/me/work` with a fixed
 * payload.
 * The server's derivation and access filter are proven against a real
 * database in `server/tests/my-work-2348.sqlite.test.ts`; the last test here
 * calls the real endpoint.
 */
import { test, expect, request, type APIRequestContext, type Page } from "@playwright/test";
import { apiBase } from "../fixtures/api-base.js";
import { ADMIN_USER } from "../fixtures/seed-user.js";
import { LoginPage } from "../pages/login.page.js";

const API_BASE = apiBase();
/** A non-admin mock-auth user (`server/src/lib/auth/mock-provider.ts`). */
const ANALYST = { username: "developer", password: "password" };

/** A real project, so the analysis page the row opens loads. */
let projectId = "";

async function apiAs(username: string, password: string): Promise<APIRequestContext> {
  const login = await request.newContext({ baseURL: API_BASE });
  const res = await login.post("/api/auth/login", { data: { username, password } });
  expect(res.status(), `login ${username}: ${await res.text()}`).toBe(200);
  const { accessToken } = (await res.json()).data as { accessToken: string };
  await login.dispose();
  return request.newContext({
    baseURL: API_BASE,
    extraHTTPHeaders: { Authorization: `Bearer ${accessToken}` },
  });
}

const waiting = () => ({
  changeRequests: [
    {
      id: "run-e2e-2348",
      title: "Payments BRD.docx",
      projectId,
      projectName: "Payments",
      state: "waiting_on_me",
      since: new Date(Date.now() - 2 * 86_400_000).toISOString(),
      openQuestions: 2,
    },
  ],
  reviews: [],
  projectCount: 1,
});

async function answerMyWork(page: Page): Promise<void> {
  await page.route(
    (url) => url.pathname.endsWith("/api/me/work"),
    (route) => route.fulfill({ json: { success: true, data: waiting() } }),
  );
}

test.describe("Home is My work (#2348)", () => {
  test.beforeAll(async () => {
    // No workspace: open to the non-admin analyst too.
    const admin = await apiAs(ADMIN_USER.username, ADMIN_USER.password);
    const stamp = Date.now().toString(36);
    const res = await admin.post("/api/projects", {
      data: { name: `my-work-${stamp}`, slug: `my-work-${stamp}` },
    });
    expect(res.status(), await res.text()).toBe(201);
    projectId = (await res.json()).data.id as string;
    await admin.dispose();
  });

  test("analyst: a waiting change request is on Home and opens the Questions tab", async ({
    page,
  }) => {
    await answerMyWork(page);
    const login = new LoginPage(page);
    await login.goto();
    await login.login(ANALYST.username, ANALYST.password);
    await page.goto("/dashboard", { waitUntil: "load" });

    const myWork = page.getByRole("region", { name: "My work" });
    await expect(myWork.getByRole("heading", { name: /Waiting on your answers/ })).toBeVisible();
    await expect(myWork.getByText(/2 questions waiting/)).toBeVisible();
    for (const id of ["widget-tasks", "widget-bg-runs", "widget-scheduler"]) {
      await expect(page.getByTestId(id)).toHaveCount(0);
    }

    await myWork.getByRole("link", { name: "Payments BRD.docx" }).click();
    await expect(page).toHaveURL(
      new RegExp(`/projects/${projectId}/analysis\\?analysisId=run-e2e-2348&tab=questions`),
    );
  });

  test("admin: My work comes first, the operations widgets stay below it", async ({ page }) => {
    await answerMyWork(page);
    const login = new LoginPage(page);
    await login.goto();
    await login.login(ADMIN_USER.username, ADMIN_USER.password);
    await page.goto("/dashboard", { waitUntil: "load" });

    const myWork = page.getByRole("region", { name: "My work" });
    await expect(myWork.getByRole("heading", { name: /Waiting on your answers/ })).toBeVisible();
    const myWorkBox = await myWork.boundingBox();
    for (const id of ["widget-tasks", "widget-bg-runs", "widget-scheduler"]) {
      const widget = page.getByTestId(id);
      await expect(widget).toBeVisible();
      const box = await widget.boundingBox();
      expect(box!.y, `${id} below My work`).toBeGreaterThan(myWorkBox!.y);
    }
  });

  test("the endpoint answers the session user, with no user id taken", async () => {
    const api = await apiAs(ANALYST.username, ANALYST.password);
    try {
      const work = await api.get("/api/me/work?userId=someone-else");
      expect(work.status(), await work.text()).toBe(200);
      const data = (await work.json()).data as {
        changeRequests: unknown[];
        reviews: unknown[];
        projectCount: number;
      };
      expect(Array.isArray(data.changeRequests)).toBe(true);
      expect(Array.isArray(data.reviews)).toBe(true);
      expect(typeof data.projectCount).toBe("number");
    } finally {
      await api.dispose();
    }

    const anonymous = await request.newContext({ baseURL: API_BASE });
    try {
      expect((await anonymous.get("/api/me/work")).status()).toBe(401);
    } finally {
      await anonymous.dispose();
    }
  });
});
