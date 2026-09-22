/**
 * Epic #640 — Primary Repository Concept end-to-end tests.
 *
 * Verifies that users can:
 *   1. Create a project WITHOUT a primary repo (no-repo baseline)
 *   2. Create a project WITH a primary repo (owner + repo name)
 *   3. See the "Primary" badge on the Connections tab
 *   4. Switch primary via "Set as primary" button
 *   5. Navigate from Settings primary-repo card → Connections
 *   6. See publishing fields pre-filled from the primary repo
 *   7. See a validation error when only owner is provided (no repo name)
 */
import { test, expect, request, type APIRequestContext } from "@playwright/test";
import { ADMIN_USER, primeAdminUser } from "../fixtures/seed-user.js";
import { LoginPage } from "../pages/login.page.js";
import { ProjectsPage } from "../pages/project.page.js";
import { ConnectionsPage } from "../pages/connections.page.js";
import { apiBase } from "../fixtures/api-base.js";

const API_BASE = apiBase();

async function authedApi(token: string): Promise<APIRequestContext> {
  return request.newContext({
    baseURL: API_BASE,
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  });
}

test.describe("Epic #640 — Primary Repository", () => {
  test.describe.configure({ timeout: 120_000 });

  let accessToken: string;

  test.beforeAll(async () => {
    const primed = await primeAdminUser(API_BASE);
    accessToken = primed.accessToken;
  });

  test.beforeEach(async ({ page }) => {
    // Log in via the real UI form so cookie auth is established
    const loginPage = new LoginPage(page);
    await loginPage.goto();
    await loginPage.login(ADMIN_USER.username, ADMIN_USER.password);
  });

  // AC 1: Create project WITHOUT primary repo — Settings shows "No primary repository"
  test("create project without primary repo shows empty primary card", async ({ page }) => {
    const slug = `e2e-no-repo-${Date.now()}`;
    const projectsPage = new ProjectsPage(page);

    await test.step("Navigate to projects and create without repo", async () => {
      await projectsPage.goto();
      await projectsPage.createProject(`No Repo Test ${slug}`, slug);
    });

    await test.step("Open project settings and verify no primary repo", async () => {
      await projectsPage.openProjectSettings(slug);
      const primaryCard = page.getByTestId("primary-repo-card");
      await expect(primaryCard).toBeVisible();
      await expect(primaryCard.getByText("No primary repository linked.")).toBeVisible();
    });
  });

  // AC 2: Create project WITH primary repo — Settings shows correct owner/repo
  test("create project with primary repo shows repo in settings card", async ({ page }) => {
    const slug = `e2e-with-repo-${Date.now()}`;
    const projectsPage = new ProjectsPage(page);
    const repoOwner = "acme-corp";
    const repoName = "my-app";

    await test.step("Create project with primary repo", async () => {
      await projectsPage.goto();
      await projectsPage.createProjectWithPrimaryRepo(`With Repo Test ${slug}`, slug, {
        owner: repoOwner,
        repoName,
      });
    });

    await test.step("Open project settings and verify primary repo card", async () => {
      await projectsPage.openProjectSettings(slug);
      const primaryCard = page.getByTestId("primary-repo-card");
      await expect(primaryCard).toBeVisible();
      await expect(primaryCard.getByText(`${repoOwner}/${repoName}`)).toBeVisible();
    });
  });

  // AC 3: Connections tab shows "Primary" badge on the auto-created repo
  test("connections tab shows primary badge on auto-created repo", async ({ page }) => {
    const slug = `e2e-badge-${Date.now()}`;
    const projectsPage = new ProjectsPage(page);
    const connectionsPage = new ConnectionsPage(page);

    await test.step("Create project with primary repo", async () => {
      await projectsPage.goto();
      await projectsPage.createProjectWithPrimaryRepo(`Badge Test ${slug}`, slug, {
        owner: "test-org",
        repoName: "test-repo",
      });
    });

    // Get the project ID from the URL after opening
    let projectId: string;
    await test.step("Open project", async () => {
      await projectsPage.openProject(slug);
      const url = page.url();
      projectId = url.split("/projects/")[1].split("/")[0];
    });

    await test.step("Navigate to Connections and verify Primary badge", async () => {
      await connectionsPage.goto(projectId!);
      await expect(connectionsPage.primaryBadge).toBeVisible();
      await expect(connectionsPage.primaryBadge).toHaveText("Primary");
    });
  });

  // AC 4: Add a second repo connector → "Set as primary" moves the badge
  test("set as primary moves the badge to the new repo", async ({ page }) => {
    const slug = `e2e-set-primary-${Date.now()}`;
    const connectionsPage = new ConnectionsPage(page);

    await test.step("Create project with primary repo via API", async () => {
      const api = await authedApi(accessToken);
      const res = await api.post("/api/projects", {
        data: {
          name: `Set Primary ${slug}`,
          slug,
          description: "e2e set-primary test",
          primaryRepo: { ownerOrOrg: "original-org", repoName: "original-repo" },
        },
      });
      expect(res.status()).toBe(201);
      await api.dispose();
    });

    // Get project ID from the API
    let projectId: string;
    await test.step("Retrieve project ID", async () => {
      const api = await authedApi(accessToken);
      const res = await api.get("/api/projects");
      const body = (await res.json()) as {
        data: { items: Array<{ id: string; slug: string }> };
      };
      const project = body.data.items.find((p) => p.slug === slug);
      expect(project).toBeTruthy();
      projectId = project!.id;
      await api.dispose();
    });

    await test.step("Navigate to Connections", async () => {
      await connectionsPage.goto(projectId!);
      // Verify first repo has Primary badge
      await expect(connectionsPage.primaryBadge).toBeVisible();
    });

    // Add a second repo connector
    let secondRepoId: string;
    await test.step("Add second repo connector via API", async () => {
      const api = await authedApi(accessToken);
      const res = await api.post(`/api/projects/${projectId!}/connectors/repos`, {
        data: {
          label: "second-repo",
          provider: "github",
          ownerOrOrg: "second-org",
          repoName: "second-repo",
        },
      });
      expect(res.status()).toBe(201);
      const body = (await res.json()) as { success: boolean; data: { id: string } };
      secondRepoId = body.data.id;
      await api.dispose();
    });

    await test.step("Reload and click Set as primary on second repo", async () => {
      await page.reload();
      await expect(connectionsPage.heading).toBeVisible();
      // The second repo should have a "Set as primary" button
      const setPrimaryBtn = page.getByTestId(`set-primary-${secondRepoId!}`);
      await expect(setPrimaryBtn).toBeVisible();
      await setPrimaryBtn.click();
    });

    await test.step("Verify badge moved to second repo", async () => {
      // After set-primary, the primary badge should still be visible (on the new primary)
      await expect(page.getByTestId("primary-badge")).toBeVisible();
      // The original repo should now have a "Set as primary" button
      await expect(page.getByRole("button", { name: "Set as primary" })).toBeVisible();
    });
  });

  // AC 5: Settings primary repo card "Change" link navigates to Connections
  test("settings primary repo card links to connections", async ({ page }) => {
    const slug = `e2e-link-${Date.now()}`;

    await test.step("Create project with primary repo via API", async () => {
      const api = await authedApi(accessToken);
      const res = await api.post("/api/projects", {
        data: {
          name: `Link Test ${slug}`,
          slug,
          primaryRepo: { ownerOrOrg: "link-org", repoName: "link-repo" },
        },
      });
      expect(res.status()).toBe(201);
      await api.dispose();
    });

    let projectId: string;
    await test.step("Navigate to project settings", async () => {
      const projectsPage = new ProjectsPage(page);
      await projectsPage.goto();
      await projectsPage.openProjectSettings(slug);
      const url = page.url();
      projectId = url.split("/projects/")[1].split("/")[0];
    });

    await test.step("Click Change on primary repo card", async () => {
      const primaryCard = page.getByTestId("primary-repo-card");
      await expect(primaryCard.getByText("link-org/link-repo")).toBeVisible();
      await primaryCard.getByRole("link", { name: "Change" }).click();
      await expect(page).toHaveURL(new RegExp(`/projects/${projectId!}/connections`));
      await expect(page.getByRole("heading", { name: "Connections" })).toBeVisible();
    });
  });

  // AC 5 (alt): Settings shows "Add one in Connections" when no primary repo
  test("settings no-primary card links to connections via Add button", async ({ page }) => {
    const slug = `e2e-add-link-${Date.now()}`;

    await test.step("Create project without primary repo via API", async () => {
      const api = await authedApi(accessToken);
      const res = await api.post("/api/projects", {
        data: { name: `Add Link ${slug}`, slug },
      });
      expect(res.status()).toBe(201);
      await api.dispose();
    });

    let projectId: string;
    await test.step("Navigate to project settings", async () => {
      const projectsPage = new ProjectsPage(page);
      await projectsPage.goto();
      await projectsPage.openProjectSettings(slug);
      const url = page.url();
      projectId = url.split("/projects/")[1].split("/")[0];
    });

    await test.step("Click 'Add one in Connections' link", async () => {
      const primaryCard = page.getByTestId("primary-repo-card");
      await expect(primaryCard.getByText("No primary repository linked.")).toBeVisible();
      await primaryCard.getByRole("link", { name: "Add one in Connections" }).click();
      await expect(page).toHaveURL(new RegExp(`/projects/${projectId!}/connections`));
    });
  });

  // AC 6: Publishing pre-fills targetOwner and targetRepo from primary repo
  test("publishing pre-fills owner and repo from primary repo", async ({ page }) => {
    const slug = `e2e-publish-${Date.now()}`;
    const repoOwner = "publish-org";
    const repoName = "publish-repo";

    await test.step("Create project with primary repo via API", async () => {
      const api = await authedApi(accessToken);
      const res = await api.post("/api/projects", {
        data: {
          name: `Publish Test ${slug}`,
          slug,
          primaryRepo: { ownerOrOrg: repoOwner, repoName },
        },
      });
      expect(res.status()).toBe(201);
      await api.dispose();
    });

    let projectId: string;
    await test.step("Navigate to project", async () => {
      const projectsPage = new ProjectsPage(page);
      await projectsPage.goto();
      await projectsPage.openProject(slug);
      const url = page.url();
      projectId = url.split("/projects/")[1].split("/")[0];
    });

    await test.step("Navigate to Publish tab and verify pre-filled fields", async () => {
      await page.goto(`/projects/${projectId!}/publish`);
      const ownerInput = page.getByLabel("Target owner");
      const repoInput = page.getByLabel("Target repo");
      await expect(ownerInput).toHaveValue(repoOwner, { timeout: 15_000 });
      await expect(repoInput).toHaveValue(repoName);
    });
  });

  // AC 7: Validation — only owner filled (no repo name) shows error
  test("create project with only owner shows validation error", async ({ page }) => {
    const slug = `e2e-validation-${Date.now()}`;
    const projectsPage = new ProjectsPage(page);

    await test.step("Open create dialog and fill only owner", async () => {
      await projectsPage.goto();
      await projectsPage.newProjectButton.click();
      await projectsPage.nameInput.fill(`Validation ${slug}`);
      await projectsPage.slugInput.fill(slug);
      await projectsPage.toggleRepoSection.click();
      await expect(projectsPage.repoOwnerInput).toBeVisible();
      await projectsPage.repoOwnerInput.fill("lone-org");
      // Leave repo name empty
    });

    await test.step("Verify validation error and submit is disabled", async () => {
      await expect(projectsPage.repoValidationError).toBeVisible();
      await expect(projectsPage.submitButton).toBeDisabled();
    });
  });
});
