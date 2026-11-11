/**
 * #1368 — the chat project-scope picker was multi-select while chat supports one
 * project. Selecting two ran the turn COMPLETELY UNSCOPED with zero RAG
 * grounding, disclosed only afterwards by the degradation notice — and an
 * unscoped turn made the model shell-grep METIS's own source tree.
 *
 * Falsifiable against `main`: `toggleProject` accumulated ids into a Set, so
 * clicking two projects produced `projectIds.length === 2`; `normaliseScope`
 * did not exist; and the button read "2 projects" rather than naming one.
 *
 * #2238 — chat now searches every project of a multi-product scope, so the
 * multi-select is back on purpose: the tests that pinned "never two at once"
 * now pin that two are kept and named, and still that the label names projects.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ProjectScopeSelector, normaliseScope, type ProjectScope } from "./project-scope-selector";

const PROJECTS = [
  { id: "p1", name: "OrderBatch" },
  { id: "p2", name: "Invoicing" },
];

vi.mock("@/lib/api-client", () => ({
  apiFetch: vi.fn(async () => PROJECTS),
}));

function renderSelector(value: ProjectScope, onChange = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={qc}>
      <ProjectScopeSelector value={value} onChange={onChange} />
    </QueryClientProvider>,
  );
  return { ...utils, onChange };
}

/** The trigger is disabled until the accessible-projects query resolves. */
async function openDropdown(): Promise<void> {
  const trigger = screen.getByTestId("project-scope-selector") as HTMLButtonElement;
  await waitFor(() => expect(trigger.disabled).toBe(false));
  fireEvent.click(trigger);
}

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => {
  vi.clearAllMocks();
});

describe("normaliseScope (#1368)", () => {
  it("keeps a persisted multi-project selection, de-duplicated (#2238)", () => {
    expect(normaliseScope({ mode: "selected", projectIds: ["p1", "p2", "p1"] })).toEqual({
      mode: "selected",
      projectIds: ["p1", "p2"],
    });
  });

  it("treats an empty selection as 'all projects'", () => {
    expect(normaliseScope({ mode: "selected", projectIds: [] })).toEqual({
      mode: "all",
      projectIds: [],
    });
  });

  it("leaves a valid single selection untouched", () => {
    const scope: ProjectScope = { mode: "selected", projectIds: ["p1"] };
    expect(normaliseScope(scope)).toEqual(scope);
  });

  it("leaves 'all' untouched", () => {
    expect(normaliseScope({ mode: "all", projectIds: [] })).toEqual({
      mode: "all",
      projectIds: [],
    });
  });
});

describe("ProjectScopeSelector (#1368)", () => {
  it("names the selected project instead of counting it", async () => {
    renderSelector({ mode: "selected", projectIds: ["p1"] });
    await waitFor(() => {
      expect(screen.getByTestId("project-scope-selector").textContent).toContain("OrderBatch");
    });
    expect(screen.getByTestId("project-scope-selector").textContent).not.toContain("1 project");
  });

  it("reads 'All projects' when unscoped", async () => {
    renderSelector({ mode: "all", projectIds: [] });
    await waitFor(() => {
      expect(screen.getByTestId("project-scope-selector").textContent).toContain("All projects");
    });
  });

  it("selecting a second project ADDS it to the scope (#2238)", async () => {
    const onChange = vi.fn();
    renderSelector({ mode: "selected", projectIds: ["p1"] }, onChange);
    await openDropdown();
    const invoicing = await screen.findByRole("checkbox", { name: /Invoicing/ });
    fireEvent.click(invoicing);
    expect(onChange).toHaveBeenCalledWith({ mode: "selected", projectIds: ["p1", "p2"] });
  });

  it("offers a checkbox per project, ticked for each in the scope (#2238)", async () => {
    renderSelector({ mode: "selected", projectIds: ["p1", "p2"] });
    await openDropdown();
    await waitFor(() => {
      expect(screen.getAllByRole("checkbox")).toHaveLength(PROJECTS.length);
    });
    for (const box of screen.getAllByRole("checkbox")) expect(box).toBeChecked();
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
    // Two projects are named, never counted.
    expect(screen.getByTestId("project-scope-selector").textContent).toContain(
      "OrderBatch + Invoicing",
    );
  });

  it("clears back to 'all projects' via the All my projects option", async () => {
    const onChange = vi.fn();
    renderSelector({ mode: "selected", projectIds: ["p1"] }, onChange);
    await openDropdown();
    fireEvent.click(await screen.findByText("All my projects"));
    expect(onChange).toHaveBeenCalledWith({ mode: "all", projectIds: [] });
  });
});
