/**
 * Issue #430 — the /rule-sets page must not duplicate navigation affordances.
 * The project section-nav (ProjectTabs, from the project layout) is the single
 * coherent affordance, so the page's own "← Back to project" link is removed.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { makeWrapper } from "./test-utils";

const useParamsMock = vi.fn(() => ({ id: "proj-1" }) as { id: string } | null);

vi.mock("next/navigation", async () => {
  const actual = await vi.importActual<typeof import("next/navigation")>("next/navigation");
  return {
    ...actual,
    useParams: () => useParamsMock(),
    usePathname: () => "/projects/proj-1/rule-sets",
    useRouter: () => ({
      push: vi.fn(),
      replace: vi.fn(),
      back: vi.fn(),
      forward: vi.fn(),
      prefetch: vi.fn(),
      refresh: vi.fn(),
    }),
    useSearchParams: () => new URLSearchParams(),
  };
});

vi.mock("@/lib/scanner-api", () => ({
  scannerApi: {
    listRuleSets: vi.fn(),
    createRuleSet: vi.fn(),
    createRule: vi.fn(),
    compileRule: vi.fn(),
    gradeRule: vi.fn(),
  },
}));

import { scannerApi } from "@/lib/scanner-api";
import RuleSetsPage from "@/app/(authed)/projects/[id]/rule-sets/page";

const listMock = vi.mocked(scannerApi.listRuleSets);

describe("RuleSetsPage navigation (#430)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useParamsMock.mockReturnValue({ id: "proj-1" });
    listMock.mockResolvedValue([]);
  });

  it("does NOT render a redundant '← Back to project' link", async () => {
    render(<RuleSetsPage />, { wrapper: makeWrapper() });
    await waitFor(() => expect(screen.getByTestId("scanner-rule-sets-root")).toBeInTheDocument());
    expect(screen.queryByRole("link", { name: /back to project/i })).toBeNull();
    expect(screen.queryByText(/← Back to project/i)).toBeNull();
  });

  it("still renders the rule-sets page heading", async () => {
    render(<RuleSetsPage />, { wrapper: makeWrapper() });
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /bug-scanner rule sets/i })).toBeInTheDocument(),
    );
  });
});
