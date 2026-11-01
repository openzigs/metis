/**
 * #1627 — the Markdown export: the request it sends (through the real
 * `streamFetch`, so the URL is the one the browser requests), and the page's
 * button, which is disabled while the job runs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { makeWrapper } from "../test-utils";
import { impactView } from "./impact-fixtures";
import { view } from "./fixtures";

vi.mock("next/navigation", async () => {
  const actual = await vi.importActual<typeof import("next/navigation")>("next/navigation");
  return {
    ...actual,
    useParams: () => ({ id: "pa-0000000001" }),
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
    usePathname: () => "/portfolio/pa-0000000001",
    useSearchParams: () => new URLSearchParams(),
  };
});
vi.mock("@/hooks/use-job-events", () => ({ useJobLifecycle: () => null }));
const triggerDownload = vi.fn();
vi.mock("@/lib/plugins-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/plugins-api")>("@/lib/plugins-api");
  return { ...actual, triggerDownload: (...a: unknown[]) => triggerDownload(...a) };
});

import { portfolioApi } from "@/lib/portfolio-api";
import PortfolioAssessmentPage from "@/app/(authed)/portfolio/[id]/page";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function markdownResponse(disposition: string | null = 'attachment; filename="pa-1.md"') {
  return new Response("# Portfolio assessment\n", {
    status: 200,
    headers: {
      "Content-Type": "text/markdown",
      ...(disposition ? { "Content-Disposition": disposition } : {}),
    },
  });
}

describe("portfolioApi.exportMarkdown", () => {
  it("requests GET /api/portfolio-assessments/:id/export?format=md for Markdown", async () => {
    fetchMock.mockResolvedValue(markdownResponse());
    const { blob, filename } = await portfolioApi.exportMarkdown("pa/1");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/portfolio-assessments/pa%2F1/export?format=md");
    expect(init.method).toBe("GET");
    expect(new Headers(init.headers).get("Accept")).toBe("text/markdown");
    expect(filename).toBe("pa-1.md");
    expect(await blob.text()).toBe("# Portfolio assessment\n");
  });

  it("names the file after the id when the server gives no name", async () => {
    fetchMock.mockResolvedValue(markdownResponse(null));
    expect((await portfolioApi.exportMarkdown("pa-1")).filename).toBe(
      "portfolio-assessment-pa-1.md",
    );
  });

  it("throws the server's message on a refusal", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "Portfolio assessment not found" } }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await expect(portfolioApi.exportMarkdown("pa-1")).rejects.toThrow(
      "Portfolio assessment not found",
    );
  });
});

describe("the export button", () => {
  it("is disabled while the job runs", async () => {
    vi.spyOn(portfolioApi, "get").mockResolvedValue(view({ status: "running" }));
    const exportSpy = vi.spyOn(portfolioApi, "exportMarkdown");
    render(<PortfolioAssessmentPage />, { wrapper: makeWrapper() });
    const button = await screen.findByRole("button", { name: "Export Markdown" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "Available once the check has finished");
    expect(exportSpy).not.toHaveBeenCalled();
  });

  it("is disabled while pending too", async () => {
    vi.spyOn(portfolioApi, "get").mockResolvedValue(view({ status: "pending" }));
    render(<PortfolioAssessmentPage />, { wrapper: makeWrapper() });
    expect(await screen.findByRole("button", { name: "Export Markdown" })).toBeDisabled();
  });

  it("downloads the Markdown once the check has finished", async () => {
    const user = userEvent.setup();
    vi.spyOn(portfolioApi, "get").mockResolvedValue(impactView());
    // A fresh body per call: the auth provider may fetch too.
    fetchMock.mockImplementation(() => Promise.resolve(markdownResponse()));
    render(<PortfolioAssessmentPage />, { wrapper: makeWrapper() });
    const button = await screen.findByRole("button", { name: "Export Markdown" });
    expect(button).toBeEnabled();
    await user.click(button);
    await waitFor(() => expect(triggerDownload).toHaveBeenCalledOnce());
    expect(fetchMock.mock.calls.map(([url]) => url)).toContain(
      "/api/portfolio-assessments/pa-0000000001/export?format=md",
    );
    expect(triggerDownload.mock.calls[0][1]).toBe("pa-1.md");
  });

  it("says when the export failed", async () => {
    const user = userEvent.setup();
    vi.spyOn(portfolioApi, "get").mockResolvedValue(impactView());
    vi.spyOn(portfolioApi, "exportMarkdown").mockRejectedValue(new Error("down"));
    render(<PortfolioAssessmentPage />, { wrapper: makeWrapper() });
    await user.click(await screen.findByRole("button", { name: "Export Markdown" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not export this check.");
  });
});

describe("the page with an impact", () => {
  it("shows the BA summary first, before the coverage table and the impact view", async () => {
    vi.spyOn(portfolioApi, "get").mockResolvedValue(impactView());
    render(<PortfolioAssessmentPage />, { wrapper: makeWrapper() });
    const summary = await screen.findByTestId("portfolio-ba-summary");
    const matrix = screen.getByTestId("portfolio-coverage-matrix");
    const impact = screen.getByTestId("portfolio-impact-view");
    const after = (a: Element, b: Element) =>
      Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(after(summary, matrix)).toBe(true);
    expect(after(summary, impact)).toBe(true);
    expect(
      within(impact)
        .getAllByTestId("portfolio-affected-product")
        .map((c) => c.dataset.impact),
    ).toEqual([
      "direct-change",
      "downstream-consumer",
      "downstream-consumer",
      "downstream-consumer",
      "downstream-consumer",
    ]);
    expect(within(impact).getByRole("button", { name: "Not affected (2)" })).toBeVisible();
  });

  it("shows no impact view or summary while the job runs", async () => {
    vi.spyOn(portfolioApi, "get").mockResolvedValue({ ...impactView(), status: "running" });
    render(<PortfolioAssessmentPage />, { wrapper: makeWrapper() });
    await screen.findByTestId("portfolio-assessment-progress");
    expect(screen.queryByTestId("portfolio-impact-view")).toBeNull();
    expect(screen.queryByTestId("portfolio-ba-summary")).toBeNull();
  });
});
