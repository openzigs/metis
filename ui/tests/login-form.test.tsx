import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LoginForm, validateLogin } from "@/components/auth/login-form";
import { makeWrapper, TEST_USER } from "./test-utils";
import { useRouter, useSearchParams } from "next/navigation";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  // Default routing: the SSO buttons fetch enabled providers on mount, so the
  // mock must answer `/api/auth/sso/providers` for every render or the effect
  // throws. Tests that exercise login override the login branch via
  // `installFetch`.
  installFetch(ok({ success: true, data: { user: { id: "u-1" } } }));
  const router = (useRouter as unknown as () => Record<string, ReturnType<typeof vi.fn>>)();
  for (const fn of Object.values(router)) fn.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function ok(body: unknown, status = 200): Response {
  return {
    ok: status < 400,
    status,
    statusText: "OK",
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

function jsonRes(body: unknown, status = 200): Response {
  return {
    ok: status < 400,
    status,
    statusText: "OK",
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

/**
 * Routes fetch calls by URL: the SSO providers endpoint (called on mount by
 * <SSOButtons />) always resolves to an empty provider list, while the login
 * endpoint resolves to the supplied response. Using URL routing instead of a
 * `mockResolvedValueOnce` queue prevents the mount-time SSO fetch from
 * accidentally consuming the login response.
 */
function installFetch(loginResponse: Response): void {
  fetchMock.mockImplementation((input: unknown) => {
    const url = typeof input === "string" ? input : String(input);
    if (url.includes("/api/auth/sso/providers")) {
      return Promise.resolve(jsonRes({ data: { providers: [] } }));
    }
    if (url.includes("/api/auth/login")) {
      return Promise.resolve(loginResponse);
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
}

describe("validateLogin", () => {
  it("flags blank fields", () => {
    expect(validateLogin("", "")).toEqual({
      username: "Username is required",
      password: "Password is required",
    });
  });

  it("trims whitespace before validating username", () => {
    expect(validateLogin("   ", "pw")).toEqual({
      username: "Username is required",
    });
  });

  it("returns no errors when both fields are filled", () => {
    expect(validateLogin("u", "p")).toEqual({});
  });
});

describe("<LoginForm />", () => {
  it("renders accessible labelled inputs", () => {
    render(<LoginForm />, {
      wrapper: makeWrapper({ initialUser: TEST_USER }),
    });
    expect(screen.getByLabelText(/username/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /sign in/i })).toBeInTheDocument();
  });

  // WCAG 2.1 SC 1.3.5 Identify Input Purpose (#659) — regression guard. The
  // login form is the canonical user-info form; its H98 purpose tokens
  // (`username` / `current-password`) must never be dropped by future edits.
  it("locks the H98 autocomplete purpose tokens on the credential inputs (#659)", () => {
    render(<LoginForm />, {
      wrapper: makeWrapper({ initialUser: TEST_USER }),
    });
    expect(screen.getByLabelText(/username/i)).toHaveAttribute("autocomplete", "username");
    expect(screen.getByLabelText(/password/i)).toHaveAttribute("autocomplete", "current-password");
  });

  it("blocks submission and shows inline errors when fields are empty", async () => {
    const user = userEvent.setup();
    render(<LoginForm />, {
      wrapper: makeWrapper({ initialUser: TEST_USER }),
    });
    await user.click(screen.getByRole("button", { name: /sign in/i }));
    expect(await screen.findByText(/username is required/i)).toBeInTheDocument();
    expect(screen.getByText(/password is required/i)).toBeInTheDocument();
    // The SSO buttons fetch providers on mount, so fetch is called; assert the
    // login endpoint specifically was never hit when validation blocks submit.
    const loginCalled = fetchMock.mock.calls.some(([url]) =>
      String(url).includes("/api/auth/login"),
    );
    expect(loginCalled).toBe(false);
  });

  it("submits and redirects on success", async () => {
    installFetch(
      ok({
        success: true,
        data: {
          user: {
            id: "u-1",
            username: "tester",
            displayName: "Test",
            email: "t@x.io",
            role: "admin",
            permissions: [],
          },
        },
      }),
    );
    const user = userEvent.setup();
    render(<LoginForm />, {
      wrapper: makeWrapper({ initialUser: TEST_USER }),
    });
    await user.type(screen.getByLabelText(/username/i), "tester");
    await user.type(screen.getByLabelText(/password/i), "password");
    await user.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() => {
      const router = (useRouter as unknown as () => { replace: ReturnType<typeof vi.fn> })();
      expect(router.replace).toHaveBeenCalledWith("/dashboard");
    });
    const loginCall = fetchMock.mock.calls.find(([url]) => url === "/api/auth/login");
    expect(loginCall).toBeDefined();
  });

  it("shows the upstream error message when login is rejected", async () => {
    installFetch(ok({ success: false, error: { code: "AUTH_FAILED", message: "Bad creds" } }, 401));
    const user = userEvent.setup();
    render(<LoginForm />, {
      wrapper: makeWrapper({ initialUser: TEST_USER }),
    });
    await user.type(screen.getByLabelText(/username/i), "tester");
    await user.type(screen.getByLabelText(/password/i), "wrong");
    await user.click(screen.getByRole("button", { name: /sign in/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/bad creds/i);
  });

  it.each([
    ["//evil.com", "/dashboard"],
    ["/\\evil.com", "/dashboard"],
    ["https://evil.com", "/dashboard"],
    ["/projects", "/projects"],
  ])("redirects safely after login when next=%s", async (nextValue, expected) => {
    const params = new URLSearchParams({ next: nextValue });
    vi.mocked(useSearchParams).mockReturnValue(
      params as unknown as ReturnType<typeof useSearchParams>,
    );
    installFetch(
      ok({
        success: true,
        data: {
          user: {
            id: "u-1",
            username: "tester",
            displayName: "T",
            email: "t@x.io",
            role: "admin",
            permissions: [],
          },
        },
      }),
    );
    const user = userEvent.setup();
    render(<LoginForm />, { wrapper: makeWrapper({ initialUser: TEST_USER }) });
    await user.type(screen.getByLabelText(/username/i), "tester");
    await user.type(screen.getByLabelText(/password/i), "password");
    await user.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() => {
      const router = (useRouter as unknown as () => { replace: ReturnType<typeof vi.fn> })();
      expect(router.replace).toHaveBeenCalledWith(expected);
    });
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams() as unknown as ReturnType<typeof useSearchParams>,
    );
  });

  // #408 — an already-authenticated user (e.g. who was involuntarily bounced
  // here, or whose session the client just restored via refresh) must not be
  // stranded on the login form: auto-redirect them onward.
  it("auto-redirects an already-authenticated user to a safe next (#408)", async () => {
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams({ next: "/projects" }) as unknown as ReturnType<typeof useSearchParams>,
    );
    render(<LoginForm />, { wrapper: makeWrapper({ initialUser: TEST_USER }) });
    await waitFor(() => {
      const router = (useRouter as unknown as () => { replace: ReturnType<typeof vi.fn> })();
      expect(router.replace).toHaveBeenCalledWith("/projects");
    });
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams() as unknown as ReturnType<typeof useSearchParams>,
    );
  });

  it("auto-redirects an authenticated user to /dashboard when no next is present (#408)", async () => {
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams() as unknown as ReturnType<typeof useSearchParams>,
    );
    render(<LoginForm />, { wrapper: makeWrapper({ initialUser: TEST_USER }) });
    await waitFor(() => {
      const router = (useRouter as unknown as () => { replace: ReturnType<typeof vi.fn> })();
      expect(router.replace).toHaveBeenCalledWith("/dashboard");
    });
  });

  it("sanitizes an unsafe next on the authenticated auto-redirect (#408)", async () => {
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams({ next: "//evil.com" }) as unknown as ReturnType<typeof useSearchParams>,
    );
    render(<LoginForm />, { wrapper: makeWrapper({ initialUser: TEST_USER }) });
    await waitFor(() => {
      const router = (useRouter as unknown as () => { replace: ReturnType<typeof vi.fn> })();
      expect(router.replace).toHaveBeenCalledWith("/dashboard");
    });
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams() as unknown as ReturnType<typeof useSearchParams>,
    );
  });

  // #411 — the session-expired banner is gated strictly on `reason=expired`.
  // Render under an injected user so the auth probe is skipped (the banner is
  // independent of auth state — it reads only the `reason` query param).
  it("shows the session-expired banner only when reason=expired (#411)", () => {
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams({ reason: "expired" }) as unknown as ReturnType<typeof useSearchParams>,
    );
    render(<LoginForm />, { wrapper: makeWrapper({ initialUser: TEST_USER }) });
    const banner = screen.getByText(/your session expired — please sign in again\./i);
    expect(banner).toBeInTheDocument();
    // It is an informational status region, distinct from the submit-error alert.
    expect(banner.closest('[role="status"]')).not.toBeNull();
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams() as unknown as ReturnType<typeof useSearchParams>,
    );
  });

  it("does NOT show the session-expired banner on a normal first visit (#411)", () => {
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams() as unknown as ReturnType<typeof useSearchParams>,
    );
    render(<LoginForm />, { wrapper: makeWrapper({ initialUser: TEST_USER }) });
    expect(screen.queryByText(/your session expired/i)).not.toBeInTheDocument();
  });

  it("does NOT reflect arbitrary reason query text into the DOM (OWASP A03) (#411)", () => {
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams({
        reason: "<img src=x onerror=alert(1)>",
      }) as unknown as ReturnType<typeof useSearchParams>,
    );
    render(<LoginForm />, { wrapper: makeWrapper({ initialUser: TEST_USER }) });
    // A non-"expired" reason shows no banner at all, and the raw text never
    // appears anywhere — the copy is static and never interpolates the query.
    expect(screen.queryByText(/your session expired/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/onerror/i)).not.toBeInTheDocument();
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams() as unknown as ReturnType<typeof useSearchParams>,
    );
  });

  it("still redirects to safeRedirectPath(next) after login when reason=expired (#411)", async () => {
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams({
        next: "/projects/abc",
        reason: "expired",
      }) as unknown as ReturnType<typeof useSearchParams>,
    );
    installFetch(
      ok({
        success: true,
        data: {
          user: {
            id: "u-1",
            username: "tester",
            displayName: "T",
            email: "t@x.io",
            role: "admin",
            permissions: [],
          },
        },
      }),
    );
    const user = userEvent.setup();
    render(<LoginForm />, { wrapper: makeWrapper({ initialUser: TEST_USER }) });
    await user.type(screen.getByLabelText(/username/i), "tester");
    await user.type(screen.getByLabelText(/password/i), "password");
    await user.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() => {
      const router = (useRouter as unknown as () => { replace: ReturnType<typeof vi.fn> })();
      expect(router.replace).toHaveBeenCalledWith("/projects/abc");
    });
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams() as unknown as ReturnType<typeof useSearchParams>,
    );
  });
});
