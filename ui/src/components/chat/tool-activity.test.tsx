/**
 * #142/#143 — the chat page's tool activity: a call waiting on approval shows
 * what the model asked for and Approve / Deny; an error shows the UI's own
 * fixed text, never a message string it received.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ToolActivityList, TranscriptToolCalls } from "./tool-activity";

describe("ToolActivityList", () => {
  it("offers Approve / Deny for a pending approval and reports the choice", () => {
    const onDecide = vi.fn();
    const item = {
      callId: "c1",
      name: "query_database",
      risk: "high" as const,
      source: "metis" as const,
      phase: "awaiting_approval" as const,
      approvalId: "apr_1",
      argsPreview: '{"sql":"select 1"}',
      argsHiddenChars: true,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    render(<ToolActivityList items={[item]} onDecide={onDecide} />);
    expect(screen.getByText('{"sql":"select 1"}')).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toMatch(/invisible characters/);
    fireEvent.click(screen.getByRole("button", { name: "Approve query_database" }));
    fireEvent.click(screen.getByRole("button", { name: "Deny query_database" }));
    expect(onDecide.mock.calls.map((c) => c[1])).toEqual(["approve", "deny"]);
  });

  it("disables the buttons while a decision is in flight", () => {
    render(
      <ToolActivityList
        items={[
          {
            callId: "c1",
            name: "t",
            risk: "high",
            source: "metis",
            phase: "awaiting_approval",
            approvalId: "apr_1",
          },
        ]}
        deciding={new Set(["apr_1"])}
        onDecide={vi.fn()}
      />,
    );
    expect((screen.getByRole("button", { name: "Approve t" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("shows fixed text for an error, whatever arrives", () => {
    render(
      <ToolActivityList
        items={[
          {
            callId: "c1",
            name: "t",
            risk: null,
            source: null,
            phase: "error",
            code: "TOOL_FAILED",
          },
        ]}
        onDecide={vi.fn()}
      />,
    );
    expect(screen.getByText("The tool failed while running.")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("renders nothing when there is no activity", () => {
    const { container } = render(<ToolActivityList items={[]} onDecide={vi.fn()} />);
    expect(container.innerHTML).toBe("");
  });
});

describe("TranscriptToolCalls", () => {
  it("lists each recorded call with how it was decided", () => {
    render(
      <TranscriptToolCalls
        calls={[
          {
            id: "c1",
            name: "count_rows",
            isError: false,
            decision: "approve",
            executed: true,
            resultPreview: "7",
          },
          {
            id: "c2",
            name: "drop_table",
            isError: true,
            decision: "deny",
            executed: false,
            resultPreview: "",
          },
        ]}
      />,
    );
    expect(screen.getByText("Tools used (2)")).toBeTruthy();
    expect(screen.getByText("approved by you")).toBeTruthy();
    expect(screen.getByText("denied")).toBeTruthy();
  });
});
