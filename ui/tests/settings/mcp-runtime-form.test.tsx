/**
 * Sub-issue #283 — Runtime dropdown in the MCP CreateForm.
 *
 * Verifies:
 *   - default runtime is `native`
 *   - selecting `docker-stdio` relabels the command field to "Wrapper image"
 *     and updates the placeholder
 *   - the K8s (SSE) option is rendered but disabled (Phase B placeholder)
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

const ADMIN_USER: AuthUser = {
  id: "u-admin",
  username: "admin",
  displayName: "Admin",
  email: "admin@example.com",
  role: "admin",
  permissions: ["mcp.manage"],
};

beforeEach(() => {
  vi.clearAllMocks();
  listMock.mockResolvedValue({ items: [] });
});

async function openCreateForm() {
  const Wrapper = makeWrapper({ initialUser: ADMIN_USER });
  render(<McpAdminPage />, { wrapper: Wrapper });
  fireEvent.click(await screen.findByTestId("new-mcp-server"));
  return screen.findByTestId("mcp-runtime-select");
}

describe("MCP admin CreateForm — runtime dropdown (#283)", () => {
  it("defaults to native runtime", async () => {
    const select = (await openCreateForm()) as HTMLSelectElement;
    expect(select.value).toBe("native");
    // command field uses the native label/placeholder
    const cmd = screen.getByTestId("mcp-command-input") as HTMLInputElement;
    expect(cmd.placeholder).toBe("npx");
    expect(screen.getByText("Command")).toBeInTheDocument();
  });

  it("relabels the command field when switching to docker-stdio", async () => {
    const select = (await openCreateForm()) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "docker-stdio" } });
    expect(select.value).toBe("docker-stdio");
    expect(screen.getByText("Wrapper image")).toBeInTheDocument();
    const cmd = screen.getByTestId("mcp-command-input") as HTMLInputElement;
    expect(cmd.placeholder).toBe("ghcr.io/metis-mcps/uvx-runner:1.0");
    expect(screen.getByText(/Wrapper image must match MCP_IMAGE_ALLOWLIST/i)).toBeInTheDocument();
  });

  it("renders the K8s (SSE) option as enabled (Phase B / #272)", async () => {
    await openCreateForm();
    const k8s = screen.getByTestId("mcp-runtime-option-k8s-sse") as HTMLOptionElement;
    expect(k8s.disabled).toBe(false);
    expect(k8s.textContent).toBe("K8s (SSE)");
  });

  it("hides the transport select and shows a read-only field when k8s-sse is selected", async () => {
    const select = (await openCreateForm()) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "k8s-sse" } });
    expect(select.value).toBe("k8s-sse");
    const ro = screen.getByTestId("mcp-transport-readonly") as HTMLInputElement;
    expect(ro.value).toBe("SSE (managed)");
    expect(ro.readOnly || ro.disabled).toBe(true);
  });

  it("renders the cold-start checkbox when k8s-sse is selected", async () => {
    const select = (await openCreateForm()) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "k8s-sse" } });
    const cs = screen.getByTestId("mcp-cold-start") as HTMLInputElement;
    expect(cs.type).toBe("checkbox");
    expect(cs.checked).toBe(false);
    fireEvent.click(cs);
    expect(cs.checked).toBe(true);
  });
});
