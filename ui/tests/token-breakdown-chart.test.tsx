/**
 * Epic #511 / Issue #513 — TokenBreakdownChart component tests.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { TokenBreakdownChart } from "@/components/projects/TokenBreakdownChart";
import { makeWrapper } from "./test-utils";

vi.mock("@/lib/projects-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/projects-api")>("@/lib/projects-api");
  return {
    ...actual,
    projectsApi: {
      ...actual.projectsApi,
      getTokenBreakdown: vi.fn(),
    },
  };
});

import { projectsApi } from "@/lib/projects-api";

const getTokenBreakdown = projectsApi.getTokenBreakdown as unknown as ReturnType<typeof vi.fn>;

const mockData = {
  range: "7d",
  totalTokens: 10000,
  categories: [
    { category: "system_prompt", tokens: 1000, percentage: 0.1, trend: null },
    { category: "tool_manifests", tokens: 2000, percentage: 0.2, trend: 0.15 },
    { category: "rag_context", tokens: 3000, percentage: 0.3, trend: -0.1 },
    { category: "history", tokens: 2500, percentage: 0.25, trend: 0.05 },
    { category: "user_message", tokens: 500, percentage: 0.05, trend: null },
    { category: "code_context", tokens: 1000, percentage: 0.1, trend: 0.2 },
  ],
  biggestCategory: "rag_context",
  suggestions: ["RAG context is dominant. Consider refining chunk sizes or relevance thresholds."],
};

beforeEach(() => {
  getTokenBreakdown.mockReset();
});

describe("TokenBreakdownChart", () => {
  it("renders loading state initially", () => {
    getTokenBreakdown.mockReturnValue(new Promise(() => {})); // never resolves
    render(<TokenBreakdownChart projectId="p-1" />, { wrapper: makeWrapper({ withAuth: false }) });
    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });

  it("renders breakdown data after loading", async () => {
    getTokenBreakdown.mockResolvedValue(mockData);
    render(<TokenBreakdownChart projectId="p-1" />, { wrapper: makeWrapper({ withAuth: false }) });

    await waitFor(() => {
      expect(screen.getByText("10,000")).toBeInTheDocument();
    });

    expect(screen.getByText("System Prompt")).toBeInTheDocument();
    expect(screen.getByText("RAG Context")).toBeInTheDocument();
    expect(screen.getByText("History")).toBeInTheDocument();
  });

  it("renders optimization suggestions", async () => {
    getTokenBreakdown.mockResolvedValue(mockData);
    render(<TokenBreakdownChart projectId="p-1" />, { wrapper: makeWrapper({ withAuth: false }) });

    await waitFor(() => {
      expect(screen.getByText("Optimization Suggestions")).toBeInTheDocument();
    });
    expect(screen.getByText(/Consider refining chunk sizes/)).toBeInTheDocument();
  });

  it("renders error state on failure", async () => {
    getTokenBreakdown.mockRejectedValue(new Error("Network error"));
    render(<TokenBreakdownChart projectId="p-1" />, { wrapper: makeWrapper({ withAuth: false }) });

    await waitFor(() => {
      expect(screen.getByText("Failed to load breakdown")).toBeInTheDocument();
    });
  });

  it("switches range when buttons clicked", async () => {
    getTokenBreakdown.mockResolvedValue(mockData);
    render(<TokenBreakdownChart projectId="p-1" />, { wrapper: makeWrapper({ withAuth: false }) });

    await waitFor(() => {
      expect(screen.getByText("10,000")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("24h"));
    expect(getTokenBreakdown).toHaveBeenCalledWith("p-1", { range: "24h" });
  });

  it("renders all range buttons", () => {
    getTokenBreakdown.mockReturnValue(new Promise(() => {}));
    render(<TokenBreakdownChart projectId="p-1" />, { wrapper: makeWrapper({ withAuth: false }) });

    expect(screen.getByText("24h")).toBeInTheDocument();
    expect(screen.getByText("7d")).toBeInTheDocument();
    expect(screen.getByText("30d")).toBeInTheDocument();
  });

  it("displays trend indicators", async () => {
    getTokenBreakdown.mockResolvedValue(mockData);
    render(<TokenBreakdownChart projectId="p-1" />, { wrapper: makeWrapper({ withAuth: false }) });

    await waitFor(() => {
      // trend of 15% up for tool_manifests
      expect(screen.getByText("↑ 15%")).toBeInTheDocument();
      // trend of -10% for rag_context
      expect(screen.getByText("↓ 10%")).toBeInTheDocument();
    });
  });

  it("renders no suggestions when array is empty", async () => {
    getTokenBreakdown.mockResolvedValue({ ...mockData, suggestions: [] });
    render(<TokenBreakdownChart projectId="p-1" />, { wrapper: makeWrapper({ withAuth: false }) });

    await waitFor(() => {
      expect(screen.getByText("10,000")).toBeInTheDocument();
    });
    expect(screen.queryByText("Optimization Suggestions")).not.toBeInTheDocument();
  });
});
