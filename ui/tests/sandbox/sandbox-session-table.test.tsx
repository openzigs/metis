/**
 * Tests for SandboxSessionTable (Epic #395 #419).
 */
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  SandboxSessionTable,
  type SandboxSessionRow,
} from "@/components/sandbox/SandboxSessionTable";

function makeRow(overrides: Partial<SandboxSessionRow> = {}): SandboxSessionRow {
  return {
    id: "sb_1",
    provider: "e2b",
    vendorSandboxId: "vendor-abc-1",
    templateId: null,
    vCpus: 1,
    memMiB: 1024,
    createdAt: "2026-04-30T12:00:00.000Z",
    destroyedAt: "2026-04-30T12:00:30.000Z",
    wallClockMs: 30_000,
    costMicroUsd: 690,
    outcome: "completed",
    errorMessage: null,
    ...overrides,
  };
}

describe("<SandboxSessionTable />", () => {
  it("renders the disclosure header with the session count", () => {
    render(<SandboxSessionTable sessions={[makeRow(), makeRow({ id: "sb_2" })]} />);
    expect(screen.getByTestId("sandbox-session-table-toggle")).toHaveTextContent("2 sessions");
  });

  it("does not render the table body until toggled (defaultOpen=false)", () => {
    render(<SandboxSessionTable sessions={[makeRow()]} />);
    expect(screen.queryByTestId("sandbox-session-row-sb_1")).toBeNull();
  });

  it("renders the body when defaultOpen=true", () => {
    render(<SandboxSessionTable sessions={[makeRow()]} defaultOpen />);
    expect(screen.getByTestId("sandbox-session-row-sb_1")).toBeInTheDocument();
  });

  it("toggling the disclosure reveals + hides rows", async () => {
    const user = userEvent.setup();
    render(<SandboxSessionTable sessions={[makeRow()]} />);
    const toggle = screen.getByTestId("sandbox-session-table-toggle");
    await user.click(toggle);
    expect(screen.getByTestId("sandbox-session-row-sb_1")).toBeInTheDocument();
    await user.click(toggle);
    expect(screen.queryByTestId("sandbox-session-row-sb_1")).toBeNull();
  });

  it("renders the empty state when there are no sessions", () => {
    render(<SandboxSessionTable sessions={[]} defaultOpen />);
    expect(screen.getByTestId("sandbox-session-table-empty")).toBeInTheDocument();
  });

  it("formats cost in USD with 4 decimals", () => {
    render(<SandboxSessionTable sessions={[makeRow({ costMicroUsd: 690 })]} defaultOpen />);
    expect(screen.getByTestId("sandbox-session-cost-sb_1")).toHaveTextContent("$0.0007");
  });

  it("renders an em dash when costMicroUsd is null", () => {
    render(<SandboxSessionTable sessions={[makeRow({ costMicroUsd: null })]} defaultOpen />);
    expect(screen.getByTestId("sandbox-session-cost-sb_1")).toHaveTextContent("—");
  });

  it("renders the provider in monospace and truncates long vendor ids", () => {
    const longId = "vendor-" + "x".repeat(100);
    render(<SandboxSessionTable sessions={[makeRow({ vendorSandboxId: longId })]} defaultOpen />);
    const row = screen.getByTestId("sandbox-session-row-sb_1");
    expect(within(row).getByText("e2b")).toBeInTheDocument();
    // Truncated display + full value lives in the title attr.
    expect(row.textContent).toContain("…");
  });

  it("renders the status badge for each row", () => {
    render(<SandboxSessionTable sessions={[makeRow({ outcome: "timeout" })]} defaultOpen />);
    expect(screen.getByTestId("sandbox-badge-failed-timeout")).toBeInTheDocument();
  });
});
