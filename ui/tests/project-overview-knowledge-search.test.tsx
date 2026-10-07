/**
 * #717 — the Overview page's Knowledge search renders each hit through
 * `KnowledgeSearchHit`: a repository file by its real path, and the rank score
 * the list is ordered by rather than the `0.000` cosine of a keyword-only hit.
 * The component has its own tests; this pins that the page actually uses it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { makeWrapper, TEST_USER } from "./test-utils";

vi.mock("next/navigation", async (orig) => ({
  ...(await orig<typeof import("next/navigation")>()),
  useParams: () => ({ id: "p1" }),
  usePathname: () => "/projects/p1",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("@/lib/projects-api", async (orig) => ({
  ...(await orig<typeof import("@/lib/projects-api")>()),
  projectsApi: { get: vi.fn() },
  knowledgeApi: { search: vi.fn() },
}));
vi.mock("@/components/projects/pipeline-overview", () => ({
  ProjectPipelineOverview: () => <div data-testid="pipeline-stub" />,
}));

import ProjectOverviewPage from "@/app/(authed)/projects/[id]/page";
import { knowledgeApi, projectsApi } from "@/lib/projects-api";

const REPO_KEY = "connector:repo:c1:src/internal/model/feed.go";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(projectsApi.get).mockResolvedValue({
    id: "p1",
    name: "Alpha",
    slug: "alpha",
    status: "active",
    description: null,
    createdById: "u",
    createdAt: "",
    updatedAt: "",
  } as never);
  vi.mocked(knowledgeApi.search).mockResolvedValue({
    hits: [
      {
        chunkId: "c1",
        documentId: "d1",
        filename: REPO_KEY,
        path: "internal/model/feed.go",
        source: "repo",
        position: 3,
        text: "type Feed struct {}",
        score: 0,
        rankScore: 0.0164,
        matchedBy: ["lexical"],
        embeddingModel: "stub",
      },
    ],
    mode: "hybrid",
  } as never);
});

describe("project Overview knowledge search (#717)", () => {
  it("renders a lexical-only repo hit by its real path, without a 0.000 score", async () => {
    render(<ProjectOverviewPage />, { wrapper: makeWrapper({ initialUser: TEST_USER }) });
    fireEvent.change(await screen.findByTestId("search-query-input"), {
      target: { value: "Feed" },
    });
    fireEvent.click(screen.getByTestId("search-submit"));

    const hits = await screen.findByTestId("search-hits");
    expect(hits).toHaveTextContent("internal/model/feed.go#3");
    expect(hits.textContent).not.toContain("src/internal");
    expect(hits.textContent).not.toContain("connector:repo:");
    expect(hits.textContent).not.toContain("0.000");
    expect(hits).toHaveTextContent("keyword match");
  });
});
