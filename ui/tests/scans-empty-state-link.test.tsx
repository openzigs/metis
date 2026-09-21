/**
 * Scans list page — empty-state link follow-up.
 *
 * The empty state previously linked to the GLOBAL `/repositories` list. It must
 * now link to a PROJECT-SCOPED destination:
 *  - exactly one connected repo  → /projects/{id}/repositories/{repoId}/scanner
 *  - zero or multiple repos      → /projects/{id}/connections
 * In no case should the link point at the global `/repositories`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { makeWrapper } from "./test-utils";

const PROJECT_ID = "proj_test";

vi.mock("next/navigation", () => ({
  useParams: vi.fn(() => ({ id: PROJECT_ID })),
}));

vi.mock("@/lib/scanner-api", () => ({
  scannerApi: {
    listProjectScans: vi.fn(async () => []),
  },
}));

vi.mock("@/lib/connectors-api", () => ({
  repoConnectorsApi: {
    list: vi.fn(async () => []),
  },
}));

import { scannerApi } from "@/lib/scanner-api";
import { repoConnectorsApi } from "@/lib/connectors-api";
import ScansListPage from "@/app/(authed)/projects/[id]/scans/page";

const mockListScans = vi.mocked(scannerApi.listProjectScans);
const mockListRepos = vi.mocked(repoConnectorsApi.list);

function renderPage() {
  const Wrapper = makeWrapper({ withAuth: false });
  render(
    <Wrapper>
      <ScansListPage />
    </Wrapper>,
  );
}

/** Locate the empty-state "Scan for bugs" link by its href. */
function emptyStateLink(): HTMLAnchorElement {
  const link = screen
    .getByTestId("scans-list-card")
    .querySelector("a[href]") as HTMLAnchorElement | null;
  if (!link) throw new Error("no empty-state link found");
  return link;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("ScansListPage — empty-state link", () => {
  beforeEach(() => {
    mockListScans.mockResolvedValue([]);
  });

  it("deep-links to the repo scanner when exactly one connected repo exists", async () => {
    mockListRepos.mockResolvedValue([{ id: "repo_42" }] as never);
    renderPage();

    await screen.findByText(/no scans yet/i);
    await waitFor(() => {
      const href = emptyStateLink().getAttribute("href");
      expect(href).toBe(`/projects/${PROJECT_ID}/repositories/repo_42/scanner`);
    });
    expect(emptyStateLink().getAttribute("href")).not.toBe("/repositories");
  });

  it("links to project connections when zero connected repos exist", async () => {
    mockListRepos.mockResolvedValue([] as never);
    renderPage();

    await screen.findByText(/no scans yet/i);
    await waitFor(() => {
      const href = emptyStateLink().getAttribute("href");
      expect(href).toBe(`/projects/${PROJECT_ID}/connections`);
    });
    expect(emptyStateLink().getAttribute("href")).not.toBe("/repositories");
  });

  it("links to project connections when multiple connected repos exist", async () => {
    mockListRepos.mockResolvedValue([{ id: "repo_1" }, { id: "repo_2" }] as never);
    renderPage();

    await screen.findByText(/no scans yet/i);
    await waitFor(() => {
      const href = emptyStateLink().getAttribute("href");
      expect(href).toBe(`/projects/${PROJECT_ID}/connections`);
    });
    expect(emptyStateLink().getAttribute("href")).not.toBe("/repositories");
  });
});
