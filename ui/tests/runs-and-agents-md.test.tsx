/**
 * Epic #158 — UI tests for /runs (#153) and AGENTS.md card (#154).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { makeWrapper } from "./test-utils";

vi.mock("@/lib/runs-api", () => ({
  runsApi: {
    list: vi.fn(),
    get: vi.fn(),
    replay: vi.fn(),
  },
  agentsMdApi: {
    getMarkdown: vi.fn(),
    preview: vi.fn(),
  },
}));

vi.mock("next/navigation", async () => {
  const actual = await vi.importActual<typeof import("next/navigation")>("next/navigation");
  return {
    ...actual,
    usePathname: vi.fn(() => "/"),
    useRouter: vi.fn(() => ({
      push: vi.fn(),
      replace: vi.fn(),
      refresh: vi.fn(),
      back: vi.fn(),
      forward: vi.fn(),
      prefetch: vi.fn(),
    })),
    useSearchParams: vi.fn(() => new URLSearchParams()),
    useParams: () => ({ id: "run_42" }),
  };
});

import { runsApi, agentsMdApi } from "@/lib/runs-api";
import RunsPage from "@/app/(authed)/runs/page";
import RunDetailPage from "@/app/(authed)/runs/[id]/page";
import { AgentsMdCard } from "@/components/projects/agents-md-card";

const list = runsApi.list as unknown as ReturnType<typeof vi.fn>;
const get = runsApi.get as unknown as ReturnType<typeof vi.fn>;
const previewFn = agentsMdApi.preview as unknown as ReturnType<typeof vi.fn>;
const getMd = agentsMdApi.getMarkdown as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  list.mockReset();
  get.mockReset();
  previewFn.mockReset();
  getMd.mockReset();
});

describe("RunsPage", () => {
  it("shows the empty state when there are no runs", async () => {
    list.mockResolvedValue({ items: [] });
    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <RunsPage />
      </Wrapper>,
    );
    await waitFor(() => expect(screen.getByTestId("runs-empty")).toBeInTheDocument());
  });

  it("renders one row per run with the started timestamp linking to the detail page", async () => {
    list.mockResolvedValue({
      items: [
        {
          id: "run_1",
          sessionId: "s1",
          projectId: "p1",
          kind: "analysis",
          status: "completed",
          startedAt: "2026-04-01T00:00:00.000Z",
          completedAt: "2026-04-01T00:00:01.000Z",
          latencyMs: 1234,
          totalTokens: 99,
          costCents: 12,
          stepCount: 4,
        },
      ],
    });
    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <RunsPage />
      </Wrapper>,
    );
    await waitFor(() => expect(screen.getByTestId("runs-table")).toBeInTheDocument());
    const link = screen.getByRole("link", { name: /2026/ });
    expect(link).toHaveAttribute("href", "/runs/run_1");
    expect(screen.getByText("1234 ms")).toBeInTheDocument();
  });

  it("propagates filter changes into the query", async () => {
    list.mockResolvedValue({ items: [] });
    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <RunsPage />
      </Wrapper>,
    );
    await waitFor(() => expect(list).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText("Project ID"), {
      target: { value: "p_xyz" },
    });
    await waitFor(() =>
      expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ projectId: "p_xyz" })),
    );
  });
});

describe("RunDetailPage", () => {
  it("renders the timeline and lets the user expand a step", async () => {
    get.mockResolvedValue({
      run: {
        id: "run_42",
        sessionId: "s",
        projectId: "p",
        kind: "analysis",
        status: "completed",
        startedAt: "2026-04-01T00:00:00.000Z",
        completedAt: "2026-04-01T00:00:01.000Z",
        latencyMs: 100,
        totalTokens: 50,
        costCents: 1,
      },
      steps: [
        {
          id: "st1",
          ord: 0,
          kind: "agent_phase",
          content: { agentKey: "document" },
          spanId: null,
          traceId: null,
          latencyMs: null,
          createdAt: "2026-04-01T00:00:00.500Z",
        },
        {
          id: "st2",
          ord: 1,
          kind: "tool_call",
          content: { tool: "browser_verify", args: { url: "https://x" } },
          spanId: "abc12345",
          traceId: "trace678",
          latencyMs: 50,
          createdAt: "2026-04-01T00:00:00.800Z",
        },
      ],
    });

    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <RunDetailPage />
      </Wrapper>,
    );

    await waitFor(() => expect(screen.getByTestId("run-timeline")).toBeInTheDocument());
    expect(screen.getByTestId("run-step-0")).toHaveAttribute("data-step-kind", "agent_phase");
    // tool_call card defaults to expanded → its JSON content is visible
    expect(screen.getByTestId("run-step-1-content").textContent).toContain("browser_verify");
  });

  it("surfaces an error when the API rejects", async () => {
    get.mockRejectedValue(new Error("nope"));
    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <RunDetailPage />
      </Wrapper>,
    );
    await waitFor(() => expect(screen.getByText(/Failed to load run/i)).toBeInTheDocument());
  });
});

describe("AgentsMdCard", () => {
  it("renders preview list and copy/download buttons", async () => {
    previewFn.mockResolvedValue({
      title: "Demo",
      preface: "",
      agents: [
        {
          source: "builtin",
          name: "business-analyst",
          description: "",
          systemPrompt: "",
          tools: ["a", "b"],
        },
      ],
      mcpServers: [],
    });
    getMd.mockResolvedValue("# Demo\n\n## business-analyst\n");

    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <AgentsMdCard projectId="p1" />
      </Wrapper>,
    );

    await waitFor(() => expect(screen.getByTestId("agents-md-preview")).toBeInTheDocument());
    expect(screen.getByTestId("agents-md-summary").textContent).toContain("business-analyst");
    expect(screen.getByTestId("agents-md-copy")).not.toBeDisabled();
    expect(screen.getByTestId("agents-md-download")).not.toBeDisabled();
  });

  it("shows an error message when the API rejects", async () => {
    previewFn.mockRejectedValue(new Error("denied"));
    getMd.mockRejectedValue(new Error("denied"));
    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <AgentsMdCard projectId="p1" />
      </Wrapper>,
    );
    await waitFor(() => expect(screen.getByText(/Failed to load AGENTS.md/i)).toBeInTheDocument());
  });

  it("copies the markdown body via clipboard when Copy is clicked", async () => {
    previewFn.mockResolvedValue({ title: "T", preface: "", agents: [], mcpServers: [] });
    getMd.mockResolvedValue("BODY");
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <AgentsMdCard projectId="p1" />
      </Wrapper>,
    );
    await waitFor(() => expect(screen.getByTestId("agents-md-copy")).not.toBeDisabled());
    fireEvent.click(screen.getByTestId("agents-md-copy"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("BODY"));
  });
});
