/**
 * Issue #1591 — the requirement card's writes that #1587 left offered to a
 * viewer the server refuses.
 *
 * A sweep of every component the card renders against its server route found
 * three more: the linked-requirements panel (Add link, Unlink:
 * `project.update`, `server/src/routes/requirement-links.ts`), the duplicate
 * warning (Mark as duplicate adds a link; Not a duplicate is
 * `project.update` in `requirement-similarity.ts`) and the data-mappings panel
 * (add, remove, suggest, accept: `connector.write`, `data-mappings.ts`). Each is
 * now disabled with the reason for such a viewer. And the assignee search no
 * longer outlives a hint set while it is open.
 *
 * Every control is driven for a developer and a coordinator, built from
 * `ROLE_PERMISSIONS`; the request each sends (or does not) is read off the API
 * mock.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import {
  ROLE_PERMISSIONS,
  type PermissionKey,
  type RequirementDataMappingDetail,
  type RoleKey,
  type SimilarRequirementItem,
} from "@metis/shared";
import type { RequirementLinkView } from "@/lib/requirement-links-api";

const api = vi.hoisted(() => ({
  links: { list: vi.fn(), create: vi.fn(), remove: vi.fn(), search: vi.fn() },
  mappings: { list: vi.fn(), create: vi.fn(), remove: vi.fn(), suggest: vi.fn() },
  connectors: { list: vi.fn() },
  similar: { forRequirement: vi.fn(), notDuplicate: vi.fn(), forDraft: vi.fn() },
  assignments: { list: vi.fn(), assign: vi.fn(), unassign: vi.fn() },
}));
vi.mock("@/lib/requirement-links-api", () => ({ requirementLinksApi: api.links }));
vi.mock("@/lib/data-mappings-api", () => ({ dataMappingsApi: api.mappings }));
vi.mock("@/lib/connectors-api", () => ({ dbConnectorsApi: api.connectors }));
vi.mock("@/lib/similar-requirements-api", () => ({ similarRequirementsApi: api.similar }));
vi.mock("@/lib/collaboration-api", () => ({ assignmentApi: api.assignments }));
const apiFetch = vi.hoisted(() => vi.fn(async (_path: string): Promise<unknown> => []));
vi.mock("@/lib/api-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api-client")>()),
  apiFetch,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { AssigneePicker } from "@/components/requirements/AssigneePicker";
import { RequirementLinksPanel } from "@/components/requirements/requirement-links-panel";
import { SimilarRequirementsPanel } from "@/components/requirements/similar-requirements-panel";
import { DataMappingsPanel } from "@/components/traceability/data-mappings-panel";
import { REQUIRES_CONNECTOR_WRITE, REQUIRES_PROJECT_UPDATE } from "@/lib/permission-hints";

/** Fixture: the hint a role is rendered with, as the Analysis page derives it. */
const hintFor = (role: RoleKey, permission: PermissionKey, hint: string) =>
  ROLE_PERMISSIONS[role].includes(permission) ? undefined : hint;
const linkHint = (role: RoleKey) => hintFor(role, "project.update", REQUIRES_PROJECT_UPDATE);
const mappingHint = (role: RoleKey) => hintFor(role, "connector.write", REQUIRES_CONNECTOR_WRITE);

function renderWith(ui: ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrap = (node: ReactNode) => <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
  const view = render(wrap(ui));
  return { rerender: (next: ReactNode) => view.rerender(wrap(next)) };
}

/** A disabled button takes no hover, so the hint sits on its wrapper (#945). */
function expectBlocked(button: HTMLElement, hint: string) {
  expect(button).toBeDisabled();
  expect(button.closest("[data-hover-hint]")).toHaveAttribute("title", hint);
}
function expectOpen(button: HTMLElement) {
  expect(button).toBeEnabled();
  expect(button.closest("[data-hover-hint]")).toBeNull();
}

const LINK: RequirementLinkView = {
  id: "link-1",
  type: "depends_on",
  createdAt: "2026-11-01T00:00:00.000Z",
  sourceRequirementId: "req-1",
  targetRequirementId: "req-2",
  requirement: { id: "req-2", title: "Archive feeds", projectId: "p1", projectName: "Alpha" },
};
const MAPPING: RequirementDataMappingDetail = {
  id: "m-1",
  requirementId: "req-1",
  dbConnectorId: "db-1",
  dbConnectorLabel: "Prod DB",
  schemaName: "public",
  tableName: "invoices",
  columnName: null,
  confidence: 0.9,
  source: "manual",
  note: null,
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
};
const DUPLICATE: SimilarRequirementItem = {
  requirementId: "req-dup",
  analysisId: "ana-1",
  key: "REQ-7",
  title: "Export the invoice report",
  status: "approved",
  score: 0.9,
  label: "duplicate",
  codeLinks: [],
  codeLinksTruncated: false,
  notDuplicate: false,
  linkedAsDuplicate: false,
};

const renderLinks = (hint: string | undefined) =>
  renderWith(
    <RequirementLinksPanel
      projectId="p1"
      requirementId="req-1"
      workspaceId="ws-1"
      writeHint={hint}
    />,
  );
const renderMappings = (hint: string | undefined) =>
  renderWith(<DataMappingsPanel projectId="p1" requirementId="req-1" writeHint={hint} />);
const renderSimilar = (hint: string | undefined) =>
  renderWith(<SimilarRequirementsPanel projectId="p1" requirementId="req-1" writeHint={hint} />);

beforeEach(() => {
  vi.clearAllMocks();
  api.links.list.mockResolvedValue({ outgoing: [LINK], incoming: [] });
  api.links.remove.mockResolvedValue({ removed: true });
  api.links.create.mockResolvedValue({});
  api.links.search.mockResolvedValue({ items: [], page: 1, pageSize: 20, total: 0 });
  api.mappings.list.mockResolvedValue([MAPPING]);
  api.mappings.remove.mockResolvedValue(undefined);
  api.mappings.suggest.mockResolvedValue({ candidates: [], note: null });
  api.connectors.list.mockResolvedValue([{ id: "db-1", label: "Prod DB" }]);
  api.similar.forRequirement.mockResolvedValue({ items: [DUPLICATE] });
  api.similar.notDuplicate.mockResolvedValue({ notDuplicate: true });
  api.assignments.list.mockResolvedValue([]);
});

describe("#1591 — a developer cannot reach the card's link, duplicate or mapping writes", () => {
  it("linked requirements: Add link and Unlink are disabled with the hint; nothing is sent", async () => {
    const hint = linkHint("developer")!;
    renderLinks(hint);
    const unlink = await screen.findByRole("button", { name: "Unlink Archive feeds" });
    const add = screen.getByRole("button", { name: "Add link" });
    expectBlocked(add, REQUIRES_PROJECT_UPDATE);
    expectBlocked(unlink, REQUIRES_PROJECT_UPDATE);
    fireEvent.click(add);
    fireEvent.click(unlink);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(api.links.remove).not.toHaveBeenCalled();
    expect(api.links.create).not.toHaveBeenCalled();
  });

  it("linked requirements: a hint set while the dialog is open closes it", async () => {
    const { rerender } = renderLinks(linkHint("coordinator"));
    fireEvent.click(await screen.findByRole("button", { name: "Add link" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    rerender(
      <RequirementLinksPanel
        projectId="p1"
        requirementId="req-1"
        workspaceId="ws-1"
        writeHint={linkHint("developer")}
      />,
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("duplicate warning: Mark as duplicate and Not a duplicate are disabled with the hint", async () => {
    renderSimilar(linkHint("developer"));
    const mark = await screen.findByRole("button", {
      name: /Mark as duplicate of/,
    });
    const notDup = screen.getByRole("button", { name: /Not a duplicate of/ });
    expectBlocked(mark, REQUIRES_PROJECT_UPDATE);
    expectBlocked(notDup, REQUIRES_PROJECT_UPDATE);
    fireEvent.click(mark);
    fireEvent.click(notDup);
    expect(api.links.create).not.toHaveBeenCalled();
    expect(api.similar.notDuplicate).not.toHaveBeenCalled();
  });

  it("data mappings: Add, Suggest and Remove are disabled with the connector.write hint", async () => {
    renderMappings(mappingHint("developer"));
    const remove = await screen.findByRole("button", { name: "Remove mapping public.invoices" });
    const add = screen.getByRole("button", { name: "Add mapping" });
    const suggest = screen.getByRole("button", { name: "Suggest mappings" });
    for (const button of [add, suggest, remove]) {
      expectBlocked(button, REQUIRES_CONNECTOR_WRITE);
      fireEvent.click(button);
    }
    expect(screen.queryByLabelText("Table")).not.toBeInTheDocument();
    expect(api.mappings.remove).not.toHaveBeenCalled();
    expect(api.mappings.suggest).not.toHaveBeenCalled();
  });

  it("data mappings: a hint set while the form and suggestions are open closes both", async () => {
    api.mappings.suggest.mockResolvedValue({
      candidates: [
        {
          dbConnectorId: "db-1",
          schemaName: "public",
          tableName: "invoices",
          columnName: "total",
          confidence: 0.8,
          lowConfidence: false,
          rationale: "Totals",
        },
      ],
      note: null,
    });
    const { rerender } = renderMappings(mappingHint("coordinator"));
    fireEvent.click(await screen.findByRole("button", { name: "Add mapping" }));
    fireEvent.click(screen.getByRole("button", { name: "Suggest mappings" }));
    await screen.findByRole("button", { name: "Accept suggestion public.invoices.total" });
    expect(screen.getByLabelText("Table")).toBeInTheDocument();

    rerender(
      <DataMappingsPanel
        projectId="p1"
        requirementId="req-1"
        writeHint={mappingHint("developer")}
      />,
    );
    expect(screen.queryByLabelText("Table")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Accept suggestion public.invoices.total" }),
    ).not.toBeInTheDocument();
    expect(api.mappings.create).not.toHaveBeenCalled();
  });

  it("assignee picker: a hint set while the search is open closes it; nothing is assigned", async () => {
    apiFetch.mockResolvedValue([{ id: "u-3", username: "sam", displayName: "Sam" }]);
    const { rerender } = renderWith(
      <AssigneePicker requirementId="req-1" projectId="p1" writeHint={linkHint("coordinator")} />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Add assignee" }));
    fireEvent.change(screen.getByPlaceholderText("Search users…"), { target: { value: "sa" } });
    await screen.findByRole("option", { name: /Sam/ });

    rerender(
      <AssigneePicker requirementId="req-1" projectId="p1" writeHint={linkHint("developer")} />,
    );
    expect(screen.queryByPlaceholderText("Search users…")).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Sam/ })).not.toBeInTheDocument();
    expect(api.assignments.assign).not.toHaveBeenCalled();
  });
});

describe("#1591 — a coordinator keeps every link, duplicate and mapping write", () => {
  it("linked requirements: Unlink is sent and Add link opens the dialog", async () => {
    renderLinks(linkHint("coordinator"));
    const unlink = await screen.findByRole("button", { name: "Unlink Archive feeds" });
    const add = screen.getByRole("button", { name: "Add link" });
    expectOpen(add);
    expectOpen(unlink);
    fireEvent.click(unlink);
    await waitFor(() => expect(api.links.remove).toHaveBeenCalledWith("link-1"));
    fireEvent.click(add);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("duplicate warning: Not a duplicate is sent; Mark as duplicate is enabled", async () => {
    renderSimilar(linkHint("coordinator"));
    const mark = await screen.findByRole("button", { name: /Mark as duplicate of/ });
    const notDup = screen.getByRole("button", { name: /Not a duplicate of/ });
    expectOpen(mark);
    expectOpen(notDup);
    fireEvent.click(notDup);
    await waitFor(() =>
      expect(api.similar.notDuplicate).toHaveBeenCalledWith("p1", "req-1", "req-dup"),
    );
  });

  it("duplicate warning: Mark as duplicate adds a duplicates link", async () => {
    renderSimilar(linkHint("coordinator"));
    fireEvent.click(await screen.findByRole("button", { name: /Mark as duplicate of/ }));
    await waitFor(() =>
      expect(api.links.create).toHaveBeenCalledWith("req-1", {
        targetRequirementId: "req-dup",
        type: "duplicates",
      }),
    );
  });

  it("data mappings: Remove and Suggest are sent; Add opens the form", async () => {
    renderMappings(mappingHint("coordinator"));
    const remove = await screen.findByRole("button", { name: "Remove mapping public.invoices" });
    const add = screen.getByRole("button", { name: "Add mapping" });
    const suggest = screen.getByRole("button", { name: "Suggest mappings" });
    for (const button of [add, suggest, remove]) expectOpen(button);
    fireEvent.click(remove);
    await waitFor(() => expect(api.mappings.remove).toHaveBeenCalledWith("p1", "req-1", "m-1"));
    fireEvent.click(suggest);
    await waitFor(() => expect(api.mappings.suggest).toHaveBeenCalledWith("p1", "req-1"));
    fireEvent.click(add);
    expect(screen.getByLabelText("Table")).toBeInTheDocument();
  });
});
