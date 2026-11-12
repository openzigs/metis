/**
 * #2337 — the in-app Help page the Help menu now opens instead of GitHub.
 */
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import HelpPage from "@/app/(authed)/help/page";
import { getProjectTabModel } from "@/components/projects/project-tabs";

describe("Help page (#2337)", () => {
  it("has a single page heading and a contact section the Help menu links to", () => {
    render(<HelpPage />);
    expect(screen.getByRole("heading", { level: 1, name: "Help" })).toBeInTheDocument();
    const contact = screen.getByTestId("help-contact");
    expect(contact).toHaveAttribute("id", "contact");
    expect(contact).toHaveTextContent(/ask your METIS administrator/i);
  });

  it("lists the project's tabs from the tab model, so it cannot drift", () => {
    render(<HelpPage />);
    const tabs = screen.getByTestId("help-project-tabs");
    for (const section of getProjectTabModel("help").sections) {
      expect(within(tabs).getByText(section.label, { exact: true })).toBeInTheDocument();
      for (const item of section.items) {
        expect(tabs).toHaveTextContent(item.label);
      }
    }
  });

  it("explains the words the app now uses in place of jargon", () => {
    render(<HelpPage />);
    const glossary = screen.getByTestId("help-glossary");
    for (const term of [
      "Sections indexed",
      "Update",
      "Full re-read",
      "Vault secret",
      "Short name",
    ]) {
      expect(within(glossary).getByText(term, { exact: true })).toBeInTheDocument();
    }
  });

  it("links nowhere outside the app", () => {
    const { container } = render(<HelpPage />);
    for (const a of Array.from(container.querySelectorAll("a"))) {
      expect(a.getAttribute("href")).toMatch(/^\//);
    }
  });
});
