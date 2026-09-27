/**
 * #268 — the Library section tabs follow the APG Tabs keyboard contract. The
 * sections themselves are stubbed: this is about the tablist, not their data.
 */
import { describe, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import LibraryPage from "@/app/(authed)/library/page";
import { expectApgTabKeyboard } from "./tab-keyboard";

vi.mock("@/components/library/browse-section", () => ({
  LibraryBrowseSection: () => <p>browse</p>,
}));
vi.mock("@/components/library/templates-section", () => ({
  TemplatesSection: () => <p>templates</p>,
}));
vi.mock("@/components/library/artifacts-section", () => ({
  ArtifactsSection: () => <p>artifacts</p>,
}));
vi.mock("@/components/library/connectors-section", () => ({
  ConnectorsSection: () => <p>connectors</p>,
}));
vi.mock("@/components/library/project-picker", () => ({
  LibraryProjectPicker: () => null,
}));

describe("LibraryPage tabs — keyboard (#268)", () => {
  it("arrow keys move between the Library sections (APG Tabs)", async () => {
    const user = userEvent.setup();
    render(<LibraryPage />);
    await screen.findByText("browse");
    await expectApgTabKeyboard(user, "Library sections");
    await screen.findByText("browse");
  });
});
