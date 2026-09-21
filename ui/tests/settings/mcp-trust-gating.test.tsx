/**
 * Sub-issue #276 — UI trust dropdown gating in MCP admin CreateForm.
 *
 * The trust dropdown is only rendered for actors with the `mcp.manage`
 * permission. Everyone else sees a locked, read-only label.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { makeWrapper } from "../test-utils";
import McpAdminPage from "@/app/(authed)/admin/mcp/page";
import type { AuthUser } from "@/lib/auth-types";
import { mcpApi } from "@/lib/mcp-api";

vi.mock("@/lib/mcp-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/mcp-api")>("@/lib/mcp-api");
  return {
    ...actual,
    mcpApi: {
      ...actual.mcpApi,
      list: vi.fn(),
    },
  };
});

const listMock = vi.mocked(mcpApi.list);

beforeEach(() => {
  vi.clearAllMocks();
  listMock.mockResolvedValue({ items: [] });
});

const ADMIN_USER: AuthUser = {
  id: "u-admin",
  username: "admin",
  displayName: "Admin",
  email: "admin@example.com",
  role: "admin",
  permissions: ["mcp.manage"],
};

const READER_USER: AuthUser = {
  id: "u-reader",
  username: "reader",
  displayName: "Reader",
  email: "reader@example.com",
  role: "reader",
  permissions: [],
};

describe("MCP admin CreateForm — trust dropdown gating (#276)", () => {
  it("shows the trust dropdown when actor has mcp.manage", async () => {
    const Wrapper = makeWrapper({ initialUser: ADMIN_USER });
    render(<McpAdminPage />, { wrapper: Wrapper });
    fireEvent.click(await screen.findByTestId("new-mcp-server"));
    expect(await screen.findByTestId("mcp-trust")).toBeInTheDocument();
    expect(screen.queryByTestId("mcp-trust-locked")).toBeNull();
  });

  it("renders the locked label (no dropdown) for non-admins", async () => {
    const Wrapper = makeWrapper({ initialUser: READER_USER });
    render(<McpAdminPage />, { wrapper: Wrapper });
    fireEvent.click(await screen.findByTestId("new-mcp-server"));
    expect(await screen.findByTestId("mcp-trust-locked")).toBeInTheDocument();
    expect(screen.queryByTestId("mcp-trust")).toBeNull();
  });

  it("renders the locked label when there is no authenticated user", async () => {
    const Wrapper = makeWrapper({ initialUser: null });
    render(<McpAdminPage />, { wrapper: Wrapper });
    fireEvent.click(await screen.findByTestId("new-mcp-server"));
    expect(await screen.findByTestId("mcp-trust-locked")).toBeInTheDocument();
  });
});
