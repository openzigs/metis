/**
 * RequirementLinksPanel tests — Epic #610 (#625).
 *
 * Covers: render of both directions with direction-aware semantics, the
 * cross-project badge + deep-link, empty/error/loading states, the add-link
 * dialog (debounced workspace search, exclude-self, create), the unlink flow,
 * server error surfacing (cycle guard / authz), and the no-workspace guard.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const { requirementLinksApi, toast } = vi.hoisted(() => ({
  requirementLinksApi: {
    list: vi.fn(),
    create: vi.fn(),
    remove: vi.fn(),
    search: vi.fn(),
  },
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/requirement-links-api", () => ({ requirementLinksApi }));
vi.mock("sonner", () => ({ toast }));

import { ApiError } from "@/lib/api-client";
import {
  RequirementLinksPanel,
  linkSemantics,
} from "@/components/requirements/requirement-links-panel";
import type { RequirementLinkView, LinkedRequirementRef } from "@/lib/requirement-links-api";

function ref(over: Partial<LinkedRequirementRef> = {}): LinkedRequirementRef {
  return { id: "req-2", title: "Target req", projectId: "proj-1", projectName: "Alpha", ...over };
}

function link(over: Partial<RequirementLinkView> = {}): RequirementLinkView {
  return {
    id: "link-1",
    type: "depends_on",
    createdAt: "2026-01-01T00:00:00.000Z",
    sourceRequirementId: "req-1",
    targetRequirementId: "req-2",
    requirement: ref(),
    ...over,
  };
}

function renderPanel(props?: Partial<React.ComponentProps<typeof RequirementLinksPanel>>) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <RequirementLinksPanel
        projectId="proj-1"
        requirementId="req-1"
        workspaceId="ws-1"
        {...props}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  requirementLinksApi.list.mockResolvedValue({ outgoing: [], incoming: [] });
  requirementLinksApi.search.mockResolvedValue({ items: [], page: 1, pageSize: 20, total: 0 });
});

describe("linkSemantics", () => {
  it("maps direction-aware labels", () => {
    expect(linkSemantics("depends_on", "outgoing")).toBe("depends on");
    expect(linkSemantics("depends_on", "incoming")).toBe("required by");
    expect(linkSemantics("duplicates", "incoming")).toBe("duplicated by");
    expect(linkSemantics("derived_from", "incoming")).toBe("source of");
    expect(linkSemantics("relates_to", "outgoing")).toBe("relates to");
  });
});

describe("RequirementLinksPanel", () => {
  it("renders outgoing and incoming links with direction semantics", async () => {
    requirementLinksApi.list.mockResolvedValue({
      outgoing: [
        link({ id: "l-out", type: "depends_on", requirement: ref({ title: "Auth API" }) }),
      ],
      incoming: [
        link({
          id: "l-in",
          type: "depends_on",
          requirement: ref({ id: "req-9", title: "Billing" }),
        }),
      ],
    });
    renderPanel();

    const rows = await screen.findAllByTestId("requirement-link-row");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText("depends on")).toBeInTheDocument();
    expect(within(rows[0]).getByText("Auth API")).toBeInTheDocument();
    expect(within(rows[1]).getByText("required by")).toBeInTheDocument();
    expect(within(rows[1]).getByText("Billing")).toBeInTheDocument();
  });

  it("shows a distinct project badge that deep-links across projects", async () => {
    requirementLinksApi.list.mockResolvedValue({
      outgoing: [
        link({
          requirement: ref({ projectId: "proj-2", projectName: "Beta", title: "Cross req" }),
        }),
      ],
      incoming: [],
    });
    renderPanel();

    const badge = await screen.findByTestId("cross-project-badge");
    expect(badge).toHaveTextContent("Beta");
    expect(badge).toHaveAttribute("href", "/projects/proj-2/analysis");
  });

  it("does not render a project badge for same-project links", async () => {
    requirementLinksApi.list.mockResolvedValue({
      outgoing: [link({ requirement: ref({ projectId: "proj-1" }) })],
      incoming: [],
    });
    renderPanel();

    await screen.findByTestId("requirement-link-row");
    expect(screen.queryByTestId("cross-project-badge")).not.toBeInTheDocument();
  });

  it("shows the empty state when there are no links", async () => {
    renderPanel();
    expect(await screen.findByText(/No linked requirements yet/i)).toBeInTheDocument();
  });

  it("shows an error state when the list query fails", async () => {
    requirementLinksApi.list.mockRejectedValue(new Error("boom"));
    renderPanel();
    expect(await screen.findByRole("alert")).toHaveTextContent(/Failed to load requirement links/i);
  });

  it("searches the workspace and creates a link, refreshing the panel", async () => {
    const user = userEvent.setup();
    requirementLinksApi.search.mockResolvedValue({
      items: [ref({ id: "req-2", title: "Payments", projectName: "Alpha" })],
      page: 1,
      pageSize: 20,
      total: 1,
    });
    requirementLinksApi.create.mockResolvedValue(link());
    renderPanel();
    await screen.findByText(/No linked requirements yet/i);

    await user.click(screen.getByRole("button", { name: "Add link" }));
    await user.type(screen.getByLabelText("Search requirements"), "pay");

    const result = await screen.findByTestId("requirement-search-result");
    expect(within(result).getByText("Payments")).toBeInTheDocument();

    expect(requirementLinksApi.search).toHaveBeenCalledWith("ws-1", { q: "pay", pageSize: 20 });

    await user.click(within(result).getByRole("button", { name: "Link to Payments" }));

    await waitFor(() =>
      expect(requirementLinksApi.create).toHaveBeenCalledWith("req-1", {
        targetRequirementId: "req-2",
        type: "relates_to",
      }),
    );
    expect(toast.success).toHaveBeenCalledWith("Link added");
  });

  it("creates a link with a chosen non-default type", async () => {
    const user = userEvent.setup();
    requirementLinksApi.search.mockResolvedValue({
      items: [ref({ id: "req-5", title: "Ledger" })],
      page: 1,
      pageSize: 20,
      total: 1,
    });
    requirementLinksApi.create.mockResolvedValue(link());
    renderPanel();
    await screen.findByText(/No linked requirements yet/i);

    await user.click(screen.getByRole("button", { name: "Add link" }));
    await user.selectOptions(screen.getByLabelText("Link type"), "depends_on");
    await user.type(screen.getByLabelText("Search requirements"), "led");

    const result = await screen.findByTestId("requirement-search-result");
    await user.click(within(result).getByRole("button", { name: "Link to Ledger" }));

    await waitFor(() =>
      expect(requirementLinksApi.create).toHaveBeenCalledWith("req-1", {
        targetRequirementId: "req-5",
        type: "depends_on",
      }),
    );
  });

  it("excludes the current requirement from search results", async () => {
    const user = userEvent.setup();
    requirementLinksApi.search.mockResolvedValue({
      items: [ref({ id: "req-1", title: "Self" }), ref({ id: "req-2", title: "Other" })],
      page: 1,
      pageSize: 20,
      total: 2,
    });
    renderPanel();
    await screen.findByText(/No linked requirements yet/i);

    await user.click(screen.getByRole("button", { name: "Add link" }));
    await user.type(screen.getByLabelText("Search requirements"), "e");

    const results = await screen.findAllByTestId("requirement-search-result");
    expect(results).toHaveLength(1);
    expect(within(results[0]).getByText("Other")).toBeInTheDocument();
  });

  it("shows an empty search state when nothing matches", async () => {
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText(/No linked requirements yet/i);

    await user.click(screen.getByRole("button", { name: "Add link" }));
    await user.type(screen.getByLabelText("Search requirements"), "zzz");

    expect(await screen.findByText(/No matching requirements found/i)).toBeInTheDocument();
  });

  it("surfaces a server error (cycle guard / authz) as an actionable message", async () => {
    const user = userEvent.setup();
    requirementLinksApi.search.mockResolvedValue({
      items: [ref({ id: "req-2", title: "Cyclic" })],
      page: 1,
      pageSize: 20,
      total: 1,
    });
    requirementLinksApi.create.mockRejectedValue(
      new ApiError(409, "This link would create a dependency cycle", "DEPENDENCY_CYCLE"),
    );
    renderPanel();
    await screen.findByText(/No linked requirements yet/i);

    await user.click(screen.getByRole("button", { name: "Add link" }));
    await user.type(screen.getByLabelText("Search requirements"), "cyc");
    const result = await screen.findByTestId("requirement-search-result");
    await user.click(within(result).getByRole("button", { name: "Link to Cyclic" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/dependency cycle/i);
    expect(toast.error).toHaveBeenCalledWith("This link would create a dependency cycle");
  });

  it("unlinks a link and refreshes", async () => {
    const user = userEvent.setup();
    requirementLinksApi.list.mockResolvedValue({
      outgoing: [link({ requirement: ref({ title: "Removable" }) })],
      incoming: [],
    });
    requirementLinksApi.remove.mockResolvedValue({ removed: true });
    renderPanel();

    const row = await screen.findByTestId("requirement-link-row");
    await user.click(within(row).getByRole("button", { name: "Unlink Removable" }));

    await waitFor(() => expect(requirementLinksApi.remove).toHaveBeenCalledWith("link-1"));
    expect(toast.success).toHaveBeenCalledWith("Link removed");
  });

  it("surfaces an unlink error", async () => {
    const user = userEvent.setup();
    requirementLinksApi.list.mockResolvedValue({
      outgoing: [link({ requirement: ref({ title: "Guarded" }) })],
      incoming: [],
    });
    requirementLinksApi.remove.mockRejectedValue(
      new ApiError(403, "You do not have access to one of the linked projects", "FORBIDDEN"),
    );
    renderPanel();

    const row = await screen.findByTestId("requirement-link-row");
    await user.click(within(row).getByRole("button", { name: "Unlink Guarded" }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "You do not have access to one of the linked projects",
      ),
    );
  });

  it("guards the dialog when the project has no workspace", async () => {
    const user = userEvent.setup();
    renderPanel({ workspaceId: null });
    await screen.findByText(/No linked requirements yet/i);

    await user.click(screen.getByRole("button", { name: "Add link" }));
    expect(await screen.findByText(/not part of a workspace/i)).toBeInTheDocument();
    expect(screen.queryByLabelText("Search requirements")).not.toBeInTheDocument();
    expect(requirementLinksApi.search).not.toHaveBeenCalled();
  });
});
