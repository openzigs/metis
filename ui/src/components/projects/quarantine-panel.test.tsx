/**
 * #2547 — the quarantine reviewer shows each document's "Restricted" badge and
 * lets a reviewer with `document.upload` who can read the document set its
 * access list before approving it.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { QuarantineRow } from "@/lib/projects-api";

let viewer: { id: string; role: string } | null = { id: "u-alice", role: "coordinator" };
vi.mock("@/lib/auth-context", () => ({ useAuth: () => ({ user: viewer }) }));
const listQuarantine = vi.fn();
const approve = vi.fn(async () => ({}));
const reject = vi.fn(async () => ({}));
const setDocAutoApprove = vi.fn(async () => ({}));
const setProjectAutoApprove = vi.fn(async () => ({}));
vi.mock("@/lib/projects-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/projects-api")>();
  return {
    ...actual,
    quarantineApi: {
      list: (...a: unknown[]) => listQuarantine(...a),
      approve: (...a: unknown[]) => approve(...(a as [])),
      reject: (...a: unknown[]) => reject(...(a as [])),
      setDocAutoApprove: (...a: unknown[]) => setDocAutoApprove(...(a as [])),
      setProjectAutoApprove: (...a: unknown[]) => setProjectAutoApprove(...(a as [])),
    },
  };
});

const { QuarantinePanel } = await import("./quarantine-panel");

function row(over: Partial<QuarantineRow> = {}): QuarantineRow {
  return {
    documentId: "d1",
    filename: "payroll.md",
    uploadedAt: "2026-11-15T10:00:00.000Z",
    chunkCount: 3,
    indexState: "quarantined",
    autoApproveTrusted: false,
    ...over,
  };
}

function renderPanel(isArchived?: boolean) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <QuarantinePanel projectId="p1" isArchived={isArchived} />
    </QueryClientProvider>,
  );
}

const toCoordinators = [{ kind: "role" as const, value: "coordinator" }];

beforeEach(() => {
  viewer = { id: "u-alice", role: "coordinator" };
  listQuarantine.mockReset();
});

describe("QuarantinePanel — #2547 access lists", () => {
  it("badges a restricted document and opens its editor seeded with the list", async () => {
    listQuarantine.mockResolvedValue({
      items: [
        row({
          access: {
            restricted: true,
            canRead: true,
            subjects: [...toCoordinators, { kind: "user", value: "u-alice" }],
            // #2555 — the people on it, by name.
            users: [{ id: "u-alice", username: "asmith", displayName: "Alice Smith" }],
          },
        }),
      ],
      autoApproveTrustedSources: false,
    });
    renderPanel();
    expect(await screen.findByTestId("quarantine-restricted-d1")).toHaveTextContent(
      "Readable by the coordinator role, Alice Smith and admins",
    );
    fireEvent.click(screen.getByTestId("quarantine-access-toggle-d1"));
    const editor = await screen.findByTestId("acl-editor");
    expect(editor).toHaveTextContent("the coordinator role");
    expect(editor).toHaveTextContent("Alice Smith @asmith");
    fireEvent.click(screen.getByTestId("quarantine-access-toggle-d1"));
    expect(screen.queryByTestId("acl-editor")).toBeNull();
  });

  it("a reviewer the document is restricted away from sees only Restricted, and no action on it", async () => {
    viewer = { id: "u-bob", role: "developer" };
    listQuarantine.mockResolvedValue({
      items: [
        row({
          filename: "Restricted",
          restricted: true,
          access: { restricted: true, canRead: false },
        }),
      ],
      autoApproveTrustedSources: false,
    });
    renderPanel();
    expect(await screen.findByTestId("quarantine-restricted-d1")).toHaveTextContent(/^Restricted$/);
    // Owner policy (#2547): one who cannot read it cannot manage it either.
    expect(screen.queryByTestId("quarantine-access-toggle-d1")).toBeNull();
    expect(screen.queryByTestId("approve-d1")).toBeNull();
    expect(screen.queryByTestId("reject-d1")).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "Auto-approve Restricted" })).toBeNull();
    expect(screen.getByTestId("quarantine-unreadable-d1")).toHaveTextContent(
      "Only its readers or an admin can review it",
    );
  });

  it("offers no access editor on an archived project", async () => {
    listQuarantine.mockResolvedValue({
      items: [row({ access: { restricted: true, canRead: true, subjects: toCoordinators } })],
      autoApproveTrustedSources: false,
    });
    renderPanel(true);
    await screen.findByTestId("quarantine-restricted-d1");
    expect(screen.queryByTestId("quarantine-access-toggle-d1")).toBeNull();
    expect(screen.getByTestId("approve-d1")).toBeInTheDocument();
  });

  it("offers no editor to a role without document.upload; an open row has no badge", async () => {
    viewer = { id: "u-rita", role: "reader" };
    listQuarantine.mockResolvedValue({
      items: [row({ access: { restricted: false, canRead: true, subjects: [] } })],
      autoApproveTrustedSources: false,
    });
    renderPanel();
    await screen.findByTestId("quarantine-row-d1");
    expect(screen.queryByTestId("quarantine-restricted-d1")).toBeNull();
    expect(screen.queryByTestId("quarantine-access-toggle-d1")).toBeNull();
  });
});

// The row was restructured to hold the editor; its review actions still reach the API.
describe("QuarantinePanel — review actions around the access editor", () => {
  it("approves, rejects and trusts a quarantined row, and toggles project auto-approve", async () => {
    listQuarantine.mockResolvedValue({ items: [row()], autoApproveTrustedSources: false });
    renderPanel();
    await screen.findByTestId("quarantine-row-d1");
    fireEvent.click(screen.getByTestId("approve-d1"));
    await waitFor(() => expect(approve).toHaveBeenCalledWith("p1", "d1"));
    fireEvent.click(screen.getByTestId("reject-d1"));
    await waitFor(() => expect(reject).toHaveBeenCalledWith("p1", "d1"));
    fireEvent.click(screen.getByRole("checkbox", { name: "Auto-approve payroll.md" }));
    await waitFor(() => expect(setDocAutoApprove).toHaveBeenCalledWith("p1", "d1", true));
    fireEvent.click(screen.getByTestId("project-auto-approve"));
    await waitFor(() => expect(setProjectAutoApprove).toHaveBeenCalledWith("p1", true));
  });

  it("offers a retry on a reconciling row and says when the queue is empty or unreadable", async () => {
    listQuarantine.mockResolvedValueOnce({
      items: [row({ indexState: "reconciling", errorMessage: "embedder down" })],
      autoApproveTrustedSources: true,
    });
    const { unmount } = renderPanel();
    expect(await screen.findByTestId("approve-d1")).toHaveTextContent("Retry indexing");
    expect(screen.getByText("embedder down")).toBeInTheDocument();
    expect(screen.queryByTestId("reject-d1")).toBeNull();
    unmount();

    listQuarantine.mockResolvedValueOnce({ items: [], autoApproveTrustedSources: false });
    const second = renderPanel();
    expect(await screen.findByText("Quarantine is empty.")).toBeInTheDocument();
    second.unmount();

    listQuarantine.mockRejectedValueOnce(new Error("boom"));
    renderPanel();
    expect(await screen.findByText(/Unable to load quarantine: boom/)).toBeInTheDocument();
  });
});
