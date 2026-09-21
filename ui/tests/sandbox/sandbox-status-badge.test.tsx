/**
 * Tests for SandboxStatusBadge (Epic #395 #419).
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  SandboxStatusBadge,
  classifySandboxOutcome,
} from "@/components/sandbox/SandboxStatusBadge";

describe("classifySandboxOutcome", () => {
  it("maps null → pending", () => {
    expect(classifySandboxOutcome(null)).toBe("pending");
  });
  it("maps completed + no error → passed", () => {
    expect(classifySandboxOutcome("completed", null)).toBe("passed");
  });
  it("maps completed + errorMessage → failed-exit", () => {
    expect(classifySandboxOutcome("completed", "exit 1")).toBe("failed-exit");
  });
  it("maps timeout → failed-timeout", () => {
    expect(classifySandboxOutcome("timeout")).toBe("failed-timeout");
  });
  it("maps killed → error", () => {
    expect(classifySandboxOutcome("killed")).toBe("error");
  });
  it("maps error → error", () => {
    expect(classifySandboxOutcome("error")).toBe("error");
  });
  it("falls back to pending for unknown outcomes", () => {
    expect(classifySandboxOutcome("garbage-from-future")).toBe("pending");
  });
});

describe("<SandboxStatusBadge />", () => {
  it("renders PASSED in green when outcome=completed", () => {
    render(<SandboxStatusBadge outcome="completed" />);
    const badge = screen.getByTestId("sandbox-badge-passed");
    expect(badge).toHaveTextContent("PASSED");
    expect(badge.className).toMatch(/green/);
  });

  it("renders FAILED:TIMEOUT in amber when outcome=timeout", () => {
    render(<SandboxStatusBadge outcome="timeout" />);
    const badge = screen.getByTestId("sandbox-badge-failed-timeout");
    expect(badge).toHaveTextContent(/timeout/i);
    expect(badge.className).toMatch(/amber/);
  });

  it("renders ERROR in red and exposes errorMessage in title attr (hover tooltip)", () => {
    render(<SandboxStatusBadge outcome="error" errorMessage="container OOM-killed" />);
    const badge = screen.getByTestId("sandbox-badge-error");
    expect(badge).toHaveTextContent("ERROR");
    expect(badge.className).toMatch(/red/);
    expect(badge.getAttribute("title")).toContain("container OOM-killed");
  });

  it("renders PENDING when outcome is null (sandbox still running)", () => {
    render(<SandboxStatusBadge outcome={null} />);
    expect(screen.getByTestId("sandbox-badge-pending")).toHaveTextContent("PENDING");
  });

  it("exposes role='status' + aria-label for screen readers", () => {
    render(<SandboxStatusBadge outcome="completed" />);
    const badge = screen.getByTestId("sandbox-badge-passed");
    expect(badge.getAttribute("role")).toBe("status");
    expect(badge.getAttribute("aria-label")).toMatch(/passed/i);
  });
});
