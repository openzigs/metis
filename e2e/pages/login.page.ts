/**
 * Login page object for the full-flow Playwright suite.
 *
 * Encapsulates the form selectors and submit interaction. Uses
 * accessible-by-label locators so changes to internal markup (test ids,
 * class names) do not break the test.
 */
import { expect, type Locator, type Page } from "@playwright/test";

export class LoginPage {
  readonly page: Page;
  readonly title: Locator;
  readonly username: Locator;
  readonly password: Locator;
  readonly submit: Locator;
  readonly error: Locator;

  constructor(page: Page) {
    this.page = page;
    // shadcn/ui's CardTitle renders as a <div>, not a heading element.
    this.title = page.getByText("Sign in to METIS", { exact: true });
    this.username = page.getByLabel("Username");
    this.password = page.getByLabel("Password");
    // Exact match: once an SSO IdP is enabled the login page also renders
    // "Sign in with <IdP>" buttons, which a /Sign in/ regex also matches.
    this.submit = page.getByRole("button", { name: "Sign in", exact: true });
    // The login form's inline error. NOT a bare `getByRole("alert")`: after any
    // client-side navigation Next.js mounts its own route announcer with
    // `role="alert"`, and the two collide under strict mode.
    this.error = page.locator("#login-error");
  }

  async goto(): Promise<void> {
    await this.page.goto("/login", { waitUntil: "load" });
    await expect(this.title).toBeVisible();
    // Wait for the AuthProvider's initial /api/auth/me probe (fired in a
    // useEffect after hydration) to settle. Otherwise a race exists where
    // login() sets the user, then the still-in-flight /me 401 resolves
    // and clobbers the user back to null, which the (authed) AppShell
    // then bounces to /login. We use a long timeout because Next.js dev
    // compiles route handlers on first hit.
    await this.page
      .waitForResponse(
        (res) => res.url().endsWith("/api/auth/me") && res.request().method() === "GET",
        { timeout: 30_000 },
      )
      .catch(() => {
        // Swallow: if /me already settled before we attached the listener
        // (for example with a hot Next.js cache), there is nothing to wait
        // for and we can proceed safely.
      });
    // Also wait for network quiescence so any in-flight cookie writes are
    // committed before we submit the form.
    await this.page.waitForLoadState("networkidle").catch(() => undefined);
  }

  async login(username: string, password: string): Promise<void> {
    await this.username.fill(username);
    await this.password.fill(password);
    // Use a generous timeout: cold Next.js dev compile of the
    // POST /api/auth/login route handler can take 20s+ on first run.
    await Promise.all([
      this.page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 60_000 }),
      this.submit.click(),
    ]);
  }

  /** Convenience: navigates to login and signs in as the default admin user. */
  async loginAsAdmin(): Promise<void> {
    await this.goto();
    await this.login("admin", "password");
  }
}
