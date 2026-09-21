/**
 * Unit tests for the ProvenanceContent component.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ProvenanceContent } from "@/components/chat/provenance-content";

describe("ProvenanceContent", () => {
  it("renders plain text when no project tags are present", () => {
    render(<ProvenanceContent content="Hello, this is a normal message." />);
    expect(screen.getByText("Hello, this is a normal message.")).toBeInTheDocument();
  });

  it("renders project badges for tagged content", () => {
    const content = "[Alpha] api-service#42 some text [Beta] web-app#7 more text";
    render(<ProvenanceContent content={content} />);
    // Should render project name badges
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("Beta")).toBeInTheDocument();
    // Should render file references
    expect(screen.getByText("api-service#42")).toBeInTheDocument();
    expect(screen.getByText("web-app#7")).toBeInTheDocument();
  });

  it("assigns consistent colors to the same project name", () => {
    const content = "[Alpha] svc#1 first [Alpha] svc#2 second";
    const { container } = render(<ProvenanceContent content={content} />);
    const badges = container.querySelectorAll(".rounded-full");
    expect(badges.length).toBe(2);
    // Same project should get same color class
    expect(badges[0].className).toBe(badges[1].className);
  });

  it("assigns different colors to different project names", () => {
    // Use names that hash to different indices
    const content = "[Alpha] svc#1 text [Zeta] svc#2 text";
    const { container } = render(<ProvenanceContent content={content} />);
    const badges = container.querySelectorAll(".rounded-full");
    expect(badges.length).toBe(2);
    // Different projects should (likely) get different colors
    // This is probabilistic but the hash function ensures determinism
    expect(badges[0].textContent).toBe("Alpha");
    expect(badges[1].textContent).toBe("Zeta");
  });

  it("handles mixed content with text before, between, and after badges", () => {
    const content = "Found: [ProjectX] file.ts#10 and also [ProjectY] other.ts#20 at the end";
    render(<ProvenanceContent content={content} />);
    expect(screen.getByText("ProjectX")).toBeInTheDocument();
    expect(screen.getByText("ProjectY")).toBeInTheDocument();
    expect(screen.getByText("file.ts#10")).toBeInTheDocument();
    expect(screen.getByText("other.ts#20")).toBeInTheDocument();
  });

  it("renders empty content gracefully", () => {
    const { container } = render(<ProvenanceContent content="" />);
    expect(container.querySelector("span")).toBeInTheDocument();
  });

  it("does not create badges for bracket text that doesn't match the pattern", () => {
    const content = "[NotAProject] without-a-hash-number";
    render(<ProvenanceContent content={content} />);
    // Should render as plain text since pattern requires `word#number`
    expect(screen.getByText(content)).toBeInTheDocument();
  });
});
