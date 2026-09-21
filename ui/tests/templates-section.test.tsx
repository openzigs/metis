import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useRouter } from "next/navigation";
import { makeWrapper } from "./test-utils";
import { TemplatesSection } from "@/components/library/templates-section";
import { templatesStore } from "@/lib/templates";

vi.mock("next/navigation", async () => {
  const actual = await vi.importActual<typeof import("next/navigation")>("next/navigation");
  return {
    ...actual,
    useRouter: vi.fn(),
  };
});

const useRouterMock = vi.mocked(useRouter);
const pushMock = vi.fn();

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  pushMock.mockReset();
  useRouterMock.mockReturnValue({
    push: pushMock,
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  } as unknown as ReturnType<typeof useRouter>);
});

afterEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

function renderSection() {
  const Wrapper = makeWrapper({ withAuth: false });
  render(
    <Wrapper>
      <TemplatesSection />
    </Wrapper>,
  );
}

describe("<TemplatesSection />", () => {
  it("shows the empty state when no templates exist", () => {
    renderSection();
    expect(screen.getByTestId("templates-empty")).toBeInTheDocument();
  });

  it("opens the editor and creates a new template", () => {
    renderSection();
    fireEvent.click(screen.getByTestId("templates-new"));
    fireEvent.change(screen.getByTestId("template-editor-name"), {
      target: { value: "My T" },
    });
    fireEvent.change(screen.getByTestId("template-editor-body"), {
      target: { value: "Hi {{user}}" },
    });
    fireEvent.change(screen.getByTestId("template-editor-required"), {
      target: { value: "user" },
    });
    fireEvent.click(screen.getByTestId("template-editor-save"));
    expect(templatesStore.list().length).toBe(1);
    expect(screen.getByText("My T")).toBeInTheDocument();
  });

  it("blocks running when a required variable is empty", () => {
    templatesStore.create({ name: "Greeter", body: "Hi {{name}}", required: ["name"] });
    renderSection();
    const card = screen.getByText("Greeter").closest("[data-testid^='template-card-']");
    const id = card?.getAttribute("data-testid")?.replace("template-card-", "");
    fireEvent.click(screen.getByTestId(`template-run-${id}`));
    fireEvent.click(screen.getByTestId("template-run-submit"));
    expect(screen.getByTestId("template-run-error")).toHaveTextContent(/Missing required/);
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("substitutes values and navigates to /workbench on Run", () => {
    templatesStore.create({ name: "Greeter", body: "Hi {{name}}", required: ["name"] });
    renderSection();
    const card = screen.getByText("Greeter").closest("[data-testid^='template-card-']");
    const id = card?.getAttribute("data-testid")?.replace("template-card-", "");
    fireEvent.click(screen.getByTestId(`template-run-${id}`));
    fireEvent.change(screen.getByTestId("template-run-var-name"), {
      target: { value: "Ada" },
    });
    fireEvent.click(screen.getByTestId("template-run-submit"));
    expect(pushMock).toHaveBeenCalledWith("/workbench");
    const stash = window.sessionStorage.getItem("metis.library.pendingRun");
    expect(stash).toContain("Hi Ada");
  });

  it("edits an existing template", () => {
    const t = templatesStore.create({ name: "T", body: "x" });
    renderSection();
    fireEvent.click(screen.getByTestId(`template-edit-${t.id}`));
    fireEvent.change(screen.getByTestId("template-editor-name"), {
      target: { value: "T2" },
    });
    fireEvent.click(screen.getByTestId("template-editor-save"));
    expect(templatesStore.get(t.id)?.name).toBe("T2");
  });

  it("deletes a template", () => {
    const t = templatesStore.create({ name: "T", body: "x" });
    renderSection();
    fireEvent.click(screen.getByTestId(`template-delete-${t.id}`));
    expect(templatesStore.list()).toEqual([]);
  });

  it("closes the editor on cancel", () => {
    renderSection();
    fireEvent.click(screen.getByTestId("templates-new"));
    expect(screen.getByTestId("template-editor")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Cancel"));
    expect(screen.queryByTestId("template-editor")).not.toBeInTheDocument();
  });

  it("closes the run dialog", () => {
    templatesStore.create({ name: "T", body: "x" });
    renderSection();
    const id = screen
      .getByText("T")
      .closest("[data-testid^='template-card-']")
      ?.getAttribute("data-testid")
      ?.replace("template-card-", "");
    fireEvent.click(screen.getByTestId(`template-run-${id}`));
    expect(screen.getByTestId("template-run-dialog")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Close"));
    expect(screen.queryByTestId("template-run-dialog")).not.toBeInTheDocument();
  });
});
