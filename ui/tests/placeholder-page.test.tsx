import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { PlaceholderPage } from "@/components/layout/placeholder-page";

describe("<PlaceholderPage />", () => {
  it("renders title + description with semantic heading", () => {
    render(<PlaceholderPage title="Skills" description="Configure skills." />);
    expect(screen.getByRole("heading", { level: 1, name: /skills/i })).toBeInTheDocument();
    expect(screen.getByText(/configure skills/i)).toBeInTheDocument();
  });
});
