import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { AppShell } from "@/components/layout/app-shell";
import { makeWrapper, TEST_USER } from "./test-utils";
import { useRouter, usePathname } from "next/navigation";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  vi.mocked(usePathname).mockReturnValue("/dashboard");
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

describe("<AppShell />", () => {
  it("redirects to /login preserving ?next + reason=expired when unauthenticated (#411)", async () => {
    // /me returns failure → AuthProvider sets user=null + isLoading=false. The
    // #408 gate keeps this as a genuine-failure redirect; #411 makes it carry the
    // current location as ?next and tag the involuntary bounce as reason=expired.
    vi.mocked(usePathname).mockReturnValue("/dashboard");
    // jsdom default search is "" so the encoded next is just the pathname.
    fetchMock
      .mockResolvedValueOnce(ok({ success: false }, 401)) // /auth/me probe → 401
      .mockResolvedValueOnce(ok({ success: false }, 401)); // /auth/refresh → 401
    render(
      <AppShell>
        <p>private</p>
      </AppShell>,
      { wrapper: makeWrapper({ initialUser: null }) },
    );
    await waitFor(() => {
      const router = (useRouter as unknown as () => { replace: ReturnType<typeof vi.fn> })();
      expect(router.replace).toHaveBeenCalledWith(
        `/login?next=${encodeURIComponent("/dashboard")}&reason=expired`,
      );
    });
  });

  it("renders the shell + children when authenticated", () => {
    render(
      <AppShell>
        <p data-testid="content">hello</p>
      </AppShell>,
      { wrapper: makeWrapper({ initialUser: TEST_USER }) },
    );
    expect(screen.getByTestId("content")).toBeInTheDocument();
    expect(screen.getByRole("main")).toBeInTheDocument();
    expect(screen.getByRole("banner")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /skip to main content/i })).toBeInTheDocument();
  });

  it("owns the canonical page gutter on <main> (R2 #157 single source)", () => {
    render(
      <AppShell>
        <p data-testid="content">hello</p>
      </AppShell>,
      { wrapper: makeWrapper({ initialUser: TEST_USER }) },
    );
    const main = screen.getByRole("main");
    expect(main.className).toContain("p-4");
    expect(main.className).toContain("md:p-6");
  });
});

/**
 * #1296 — the AGPL-3.0 §13 source offer has to be MOUNTED, not merely written.
 *
 * `source-offer-footer.test.tsx` proves the component behaves; nothing there proves
 * any page renders it. A footer that exists only in its own test file discharges no
 * licence obligation, and that gap is invisible in a green suite — which is exactly
 * the failure this arm exists to catch.
 */
describe("<AppShell /> — AGPL §13 source offer", () => {
  it("renders the source-offer footer on every authenticated page", () => {
    render(
      <AppShell>
        <p>private</p>
      </AppShell>,
      { wrapper: makeWrapper({ initialUser: TEST_USER }) },
    );
    expect(screen.getByTestId("source-offer-footer")).toBeInTheDocument();
    expect(screen.getByTestId("source-offer-link")).toHaveAttribute(
      "href",
      expect.stringContaining("https://"),
    );
  });
});
