/**
 * #2339 — the workspace pages say where the user is and lead back.
 *
 * `fetch` is a fake of the three routes the nav reads: the caller's workspaces,
 * the workspace's governing-documents list (404 while `GOVERNING_DOCS_ENABLED`
 * is off) and one project by id.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { usePathname } from "next/navigation";
import { ACTIVE_PROJECT_STORAGE_KEY } from "@/lib/active-project";
import { queryKeys } from "@/lib/query-keys";
import { WorkspaceNav, workspaceTabs } from "./workspace-nav";

const WS = "ws-1";

let governingOn: boolean;
let paths: string[];

function respond(status: number, data: unknown): Response {
  return new Response(
    JSON.stringify(
      status < 400 ? { success: true, data } : { success: false, error: { code: "NOT_FOUND" } },
    ),
    { status },
  );
}

async function handle(input: RequestInfo | URL): Promise<Response> {
  const url = new URL(String(input), "http://localhost");
  paths.push(url.pathname);
  if (url.pathname === "/api/workspaces") {
    return respond(200, [
      { id: WS, name: "Payments", slug: "payments", logoUrl: null, role: "member" },
    ]);
  }
  if (url.pathname === `/api/workspaces/${WS}/governing-documents`) {
    return governingOn ? respond(200, { documents: [] }) : respond(404, null);
  }
  if (url.pathname === "/api/projects/p-1") {
    return respond(200, { id: "p-1", name: "Card vault", slug: "card-vault", workspaceId: WS });
  }
  if (url.pathname === "/api/projects/p-2") {
    return respond(200, { id: "p-2", name: "Ledger", slug: "ledger", workspaceId: "ws-other" });
  }
  return respond(404, null);
}

function mount(
  workspaceId = WS,
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  return render(
    <QueryClientProvider client={qc}>
      <WorkspaceNav workspaceId={workspaceId} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  governingOn = true;
  paths = [];
  window.localStorage.clear();
  vi.stubGlobal("fetch", vi.fn(handle));
  vi.mocked(usePathname).mockReturnValue(`/workspaces/${WS}`);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(usePathname).mockReturnValue("/");
});

describe("workspaceTabs (#2339)", () => {
  it("lists Overview, Traceability and Governing documents first, each under the workspace", () => {
    expect(workspaceTabs(WS, true).map((t) => [t.label, t.href])).toEqual([
      ["Overview", `/workspaces/${WS}`],
      ["Traceability", `/workspaces/${WS}/traceability`],
      ["Governing documents", `/workspaces/${WS}/governing`],
      ["Usage & cost", `/settings/usage?scope=workspace&workspaceId=${WS}`],
      ["New Agent", `/workspaces/${WS}/agents/new`],
    ]);
  });

  it("leaves Governing documents out while the feature is off", () => {
    expect(workspaceTabs(WS, false).map((t) => t.label)).not.toContain("Governing documents");
  });
});

describe("WorkspaceNav (#2339)", () => {
  it("names the workspace the user is in", async () => {
    mount();
    await waitFor(() =>
      expect(screen.getByTestId("workspace-nav-name")).toHaveTextContent("Payments"),
    );
    expect(screen.getByTestId("workspace-nav-name").parentElement).toHaveTextContent(
      "Workspace: Payments",
    );
  });

  it("falls back to a generic name for a workspace not in the caller's list", async () => {
    mount("ws-other");
    // Let the list's response settle before asserting the fallback.
    await waitFor(() => expect(paths).toContain("/api/workspaces"));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.getByTestId("workspace-nav-name")).toHaveTextContent(/^Workspace$/);
    // Not "Workspace: Workspace".
    expect(screen.getByTestId("workspace-nav-name").parentElement).toHaveTextContent(/^Workspace$/);
  });

  it("does not mark Overview current on a sub-page", async () => {
    vi.mocked(usePathname).mockReturnValue(`/workspaces/${WS}/governing`);
    mount();
    const nav = screen.getByRole("navigation", { name: "Workspace" });
    const governing = await within(nav).findByRole("link", { name: "Governing documents" });
    expect(governing).toHaveAttribute("aria-current", "page");
    expect(within(nav).getByRole("link", { name: "Overview" })).not.toHaveAttribute("aria-current");
  });

  it("puts Traceability and Governing documents one click away, the current page marked", async () => {
    vi.mocked(usePathname).mockReturnValue(`/workspaces/${WS}/traceability`);
    mount();
    const nav = screen.getByRole("navigation", { name: "Workspace" });
    const governing = await within(nav).findByRole("link", { name: "Governing documents" });
    expect(governing).toHaveAttribute("href", `/workspaces/${WS}/governing`);
    const traceability = within(nav).getByRole("link", { name: "Traceability" });
    expect(traceability).toHaveAttribute("href", `/workspaces/${WS}/traceability`);
    expect(traceability).toHaveAttribute("aria-current", "page");
    expect(governing).not.toHaveAttribute("aria-current");
  });

  it("shows no Governing documents link while the feature is off", async () => {
    governingOn = false;
    mount();
    await waitFor(() => expect(paths).toContain(`/api/workspaces/${WS}/governing-documents`));
    // Let the 404 settle before asserting the tab stayed hidden.
    await screen.findByText("Payments");
    expect(screen.queryByRole("link", { name: "Governing documents" })).toBeNull();
    expect(screen.getByRole("link", { name: "Traceability" })).toBeInTheDocument();
  });

  it("leads back to the project the user came from", async () => {
    window.localStorage.setItem(ACTIVE_PROJECT_STORAGE_KEY, "p-1");
    mount();
    const back = await screen.findByRole("link", { name: "Back to Card vault" });
    expect(back).toHaveAttribute("href", "/projects/p-1");
  });

  it("offers no back link to a stored project from another workspace", async () => {
    window.localStorage.setItem(ACTIVE_PROJECT_STORAGE_KEY, "p-2");
    mount();
    await waitFor(() => expect(paths).toContain("/api/projects/p-2"));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.queryByRole("link", { name: /^Back to/ })).toBeNull();
  });

  it("offers no back link when no project is known", async () => {
    mount();
    await screen.findByText("Payments");
    expect(screen.queryByRole("link", { name: /^Back to/ })).toBeNull();
    expect(paths.some((p) => p.startsWith("/api/projects"))).toBe(false);
  });

  it("offers no back link to a project that cannot be read", async () => {
    window.localStorage.setItem(ACTIVE_PROJECT_STORAGE_KEY, "p-gone");
    mount();
    await waitFor(() => expect(paths).toContain("/api/projects/p-gone"));
    await screen.findByText("Payments");
    expect(screen.queryByRole("link", { name: /^Back to/ })).toBeNull();
  });

  it("drops a back link to a cached project once a fresh read fails (deleted since)", async () => {
    window.localStorage.setItem(ACTIVE_PROJECT_STORAGE_KEY, "p-gone");
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(queryKeys.projects.detail("p-gone"), {
      id: "p-gone",
      name: "Old project",
      workspaceId: WS,
    });
    mount(WS, qc);
    expect(screen.getByRole("link", { name: "Back to Old project" })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole("link", { name: "Back to Old project" })).toBeNull(),
    );
  });
});
