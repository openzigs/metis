/**
 * #2339 — the workspace landing page the switcher's "Open workspace" opens:
 * Traceability and Governing documents each one click away.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WorkspaceOverview } from "./workspace-overview";

const WS = "ws-1";
let governingOn: boolean;
let paths: string[];

async function handle(input: RequestInfo | URL): Promise<Response> {
  const url = new URL(String(input), "http://localhost");
  paths.push(url.pathname);
  if (url.pathname === `/api/workspaces/${WS}/governing-documents` && governingOn) {
    return new Response(JSON.stringify({ success: true, data: { documents: [] } }), {
      status: 200,
    });
  }
  return new Response(JSON.stringify({ success: false, error: { code: "NOT_FOUND" } }), {
    status: 404,
  });
}

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <WorkspaceOverview workspaceId={WS} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  governingOn = true;
  paths = [];
  vi.stubGlobal("fetch", vi.fn(handle));
});

afterEach(() => vi.unstubAllGlobals());

describe("WorkspaceOverview (#2339)", () => {
  it("links to the workspace's Traceability and Governing documents", async () => {
    mount();
    expect(screen.getByRole("heading", { level: 1, name: "Overview" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Traceability/ })).toHaveAttribute(
      "href",
      `/workspaces/${WS}/traceability`,
    );
    expect(await screen.findByRole("link", { name: /Governing documents/ })).toHaveAttribute(
      "href",
      `/workspaces/${WS}/governing`,
    );
  });

  it("shows no Governing documents link while the feature is off", async () => {
    governingOn = false;
    mount();
    await waitFor(() => expect(paths).toContain(`/api/workspaces/${WS}/governing-documents`));
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByRole("link", { name: /Governing documents/ })).toBeNull();
    expect(screen.getByRole("link", { name: /Traceability/ })).toBeInTheDocument();
  });
});
