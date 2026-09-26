/**
 * #147 — a sub-agent call links to its stored transcript: fetched only when
 * opened, rendered as text, and attributed in the live activity list.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

vi.mock("@/lib/ai-client", () => ({ getSubAgentRun: vi.fn() }));

import { getSubAgentRun as getRun } from "@/lib/ai-client";
import { SubAgentRunDetails } from "./subagent-run";
import { ToolActivityList } from "./tool-activity";

const getSubAgentRun = getRun as unknown as ReturnType<typeof vi.fn>;

function wrap(children: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

const RUN = {
  id: "run-1",
  sessionId: "s1",
  parentRunId: null,
  parentCallId: "c1",
  agentRef: "custom:h",
  agentName: "Helper",
  depth: 1,
  task: "Count table t <script>alert(1)</script>",
  status: "completed",
  result: "7 rows",
  model: "gpt-4.1",
  turns: ["", "7 rows"],
  toolCalls: [
    {
      callId: "h1",
      tool: "danger_write",
      args: {},
      result: "no",
      executed: false,
      decision: "deny",
    },
    {
      callId: "h2",
      tool: "count_rows",
      args: {},
      result: "7",
      executed: true,
      decision: "auto-approve",
    },
  ],
  usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
  createdAt: "",
  completedAt: "",
};

beforeEach(() => {
  getSubAgentRun.mockReset();
});

describe("SubAgentRunDetails", () => {
  it("fetches only when opened, then shows the task, its tool calls and the answer as text", async () => {
    getSubAgentRun.mockResolvedValue(RUN);
    render(wrap(<SubAgentRunDetails sessionId="s1" runId="run-1" />));
    expect(getSubAgentRun).not.toHaveBeenCalled();
    const details = screen.getByTestId("subagent-run-run-1") as HTMLDetailsElement;
    details.open = true;
    fireEvent(details, new Event("toggle"));
    await waitFor(() => expect(screen.getByTestId("subagent-run-body")).toBeTruthy());
    expect(getSubAgentRun).toHaveBeenCalledWith("s1", "run-1");
    expect(screen.getByText("Helper")).toBeTruthy();
    expect(screen.getByText(/Count table t <script>/)).toBeTruthy(); // text, not markup
    expect(screen.getByText("denied")).toBeTruthy();
    expect(screen.getByText("allowed by policy")).toBeTruthy();
    expect(screen.getByText("7 rows")).toBeTruthy();
    expect(document.querySelector("script")).toBeNull();
  });

  it("a run stopped by the budget, with no model, no tool calls and no answer, says so plainly", async () => {
    getSubAgentRun.mockResolvedValue({
      ...RUN,
      id: "run-2",
      status: "budget_exhausted",
      model: null,
      result: "",
      toolCalls: [
        {
          callId: "x",
          tool: "flaky",
          args: {},
          result: "",
          executed: true,
          isError: true,
          errorCode: "TOOL_FAILED",
        },
      ],
    });
    render(wrap(<SubAgentRunDetails sessionId="s1" runId="run-2" />));
    const details = screen.getByTestId("subagent-run-run-2") as HTMLDetailsElement;
    details.open = true;
    fireEvent(details, new Event("toggle"));
    await waitFor(() => expect(screen.getByTestId("subagent-run-body")).toBeTruthy());
    expect(screen.getByText(/the sub-agent token budget ran out/)).toBeTruthy();
    expect(screen.getByText("(no answer)")).toBeTruthy();
    expect(screen.getByText("The tool failed while running.")).toBeTruthy();
  });

  it("says so when the run cannot be loaded", async () => {
    getSubAgentRun.mockRejectedValue(new Error("404"));
    render(wrap(<SubAgentRunDetails sessionId="s1" runId="run-x" />));
    const details = screen.getByTestId("subagent-run-run-x") as HTMLDetailsElement;
    details.open = true;
    fireEvent(details, new Event("toggle"));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toMatch(/could not be loaded/),
    );
  });
});

describe("ToolActivityList — sub-agent calls", () => {
  it("attributes a sub-agent's call and links a finished delegation to its run", () => {
    render(
      wrap(
        <ToolActivityList
          sessionId="s1"
          onDecide={vi.fn()}
          items={[
            {
              callId: "c1",
              name: "agent:custom:h",
              risk: "medium",
              source: "agent",
              phase: "result",
              resultPreview: "7 rows",
              subAgentRunId: "run-1",
            },
            {
              callId: "h2",
              name: "count_rows",
              risk: "low",
              source: "metis",
              phase: "result",
              viaAgent: { name: "Helper", parentCallId: "c1", depth: 1 },
            },
          ]}
        />,
      ),
    );
    expect(screen.getByTestId("subagent-run-run-1")).toBeTruthy();
    expect(screen.getByTestId("tool-via-agent").textContent).toBe("via Helper");
  });

  it("no session, no link", () => {
    render(
      wrap(
        <ToolActivityList
          onDecide={vi.fn()}
          items={[
            {
              callId: "c1",
              name: "a",
              risk: null,
              source: "agent",
              phase: "result",
              subAgentRunId: "r",
            },
          ]}
        />,
      ),
    );
    expect(screen.queryByTestId("subagent-run-r")).toBeNull();
  });
});
