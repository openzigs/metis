import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { PersonaTag } from "@/components/findings/persona-tag";

describe("<PersonaTag />", () => {
  const winston = {
    agentKey: "code",
    name: "Winston",
    role: "Solution Architect",
    avatar: "🏛️",
  };

  it("renders the persona avatar, name and role", () => {
    render(<PersonaTag persona={winston} agentKey="code" />);
    expect(screen.getByTestId("persona-tag-name")).toHaveTextContent("Winston");
    expect(screen.getByTestId("persona-tag-role")).toHaveTextContent("Solution Architect");
    expect(screen.getByText("🏛️")).toBeInTheDocument();
  });

  it("exposes the agent key and a descriptive title for accessibility", () => {
    render(<PersonaTag persona={winston} agentKey="code" />);
    const chip = screen.getByTestId("persona-tag");
    expect(chip).toHaveAttribute("data-agent-key", "code");
    expect(chip).toHaveAttribute("title", "Winston · Solution Architect (code)");
  });

  it("omits the role when compact", () => {
    render(<PersonaTag persona={winston} agentKey="code" compact />);
    expect(screen.queryByTestId("persona-tag-role")).not.toBeInTheDocument();
    expect(screen.getByTestId("persona-tag-name")).toHaveTextContent("Winston");
  });

  it("falls back to a generic glyph and the raw agent key when no persona resolves", () => {
    render(<PersonaTag agentKey="legacy-agent" />);
    expect(screen.getByTestId("persona-tag-name")).toHaveTextContent("legacy-agent");
    expect(screen.getByText("🤖")).toBeInTheDocument();
    expect(screen.getByTestId("persona-tag")).toHaveAttribute(
      "title",
      "legacy-agent (legacy-agent)",
    );
    expect(screen.queryByTestId("persona-tag-role")).not.toBeInTheDocument();
  });

  it("applies a supplied className", () => {
    render(<PersonaTag persona={winston} agentKey="code" className="custom-cls" />);
    expect(screen.getByTestId("persona-tag")).toHaveClass("custom-cls");
  });
});
