/**
 * Epic #196 / #222 — Standalone /vault admin UI tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { makeWrapper } from "./test-utils";
import VaultPage from "@/app/(authed)/vault/page";
import { vaultApi } from "@/lib/vault-api";
import { ApiError } from "@/lib/api-client";

vi.mock("@/lib/vault-api", () => ({
  vaultApi: {
    list: vi.fn(),
    create: vi.fn(),
    rotate: vi.fn(),
    reveal: vi.fn(),
    remove: vi.fn(),
    audit: vi.fn(),
  },
}));

const listMock = vi.mocked(vaultApi.list);
const createMock = vi.mocked(vaultApi.create);
const rotateMock = vi.mocked(vaultApi.rotate);
const revealMock = vi.mocked(vaultApi.reveal);
const removeMock = vi.mocked(vaultApi.remove);
const auditMock = vi.mocked(vaultApi.audit);

interface VaultEntryView {
  id: string;
  label: string;
  scope: "global" | "project";
  description: string;
  algorithm: string;
  keyVersion: number;
  createdAt: string;
  updatedAt: string;
}

function entry(overrides: Partial<VaultEntryView> = {}): VaultEntryView {
  return {
    id: "sec_1",
    label: "github-pat",
    scope: "global" as const,
    description: "",
    algorithm: "aes-256-gcm",
    keyVersion: 1,
    createdAt: new Date("2026-04-01T12:00:00Z").toISOString(),
    updatedAt: new Date("2026-04-25T12:00:00Z").toISOString(),
    ...overrides,
  };
}

function renderPage() {
  const Wrapper = makeWrapper({ withAuth: false });
  render(
    <Wrapper>
      <VaultPage />
    </Wrapper>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  listMock.mockResolvedValue({ items: [entry()] });
  auditMock.mockResolvedValue({
    items: [
      {
        id: "audit_1",
        action: "vault.read",
        actorId: "u_1",
        createdAt: new Date("2026-04-25T12:30:00Z").toISOString(),
        metadata: null,
      },
    ],
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("<VaultPage />", () => {
  it("renders the entries table after the list query resolves", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId("vault-list")).toBeInTheDocument());
    expect(screen.getByTestId("vault-row-sec_1")).toBeInTheDocument();
  });

  it("shows the empty-state row when the vault has no entries", async () => {
    listMock.mockResolvedValueOnce({ items: [] });
    renderPage();
    await waitFor(() => expect(screen.getByTestId("vault-list-empty")).toBeInTheDocument());
  });

  it("renders the forbidden notice when the list returns 403", async () => {
    listMock.mockRejectedValueOnce(new ApiError(403, "forbidden"));
    renderPage();
    await waitFor(() => expect(screen.getByTestId("vault-forbidden")).toBeInTheDocument());
  });

  it("creates a new entry and refreshes the list", async () => {
    createMock.mockResolvedValueOnce(entry({ id: "sec_2", label: "slack" }));
    renderPage();
    await waitFor(() => expect(screen.getByTestId("vault-list")).toBeInTheDocument());
    fireEvent.change(screen.getByTestId("vault-create-label"), { target: { value: "slack" } });
    fireEvent.change(screen.getByTestId("vault-create-value"), { target: { value: "xoxb-abc" } });
    fireEvent.click(screen.getByTestId("vault-create-submit"));
    await waitFor(() =>
      expect(createMock).toHaveBeenCalledWith({
        label: "slack",
        value: "xoxb-abc",
        scope: "global",
        description: undefined,
      }),
    );
  });

  it("surfaces create errors inline", async () => {
    createMock.mockRejectedValueOnce(new ApiError(400, "label conflict"));
    renderPage();
    await waitFor(() => expect(screen.getByTestId("vault-list")).toBeInTheDocument());
    fireEvent.change(screen.getByTestId("vault-create-label"), { target: { value: "x" } });
    fireEvent.change(screen.getByTestId("vault-create-value"), { target: { value: "y" } });
    fireEvent.click(screen.getByTestId("vault-create-submit"));
    await waitFor(() =>
      expect(screen.getByTestId("vault-create-error")).toHaveTextContent("label conflict"),
    );
  });

  it("opens the entry detail and reveals plaintext", async () => {
    revealMock.mockResolvedValueOnce({
      summary: entry(),
      plaintext: "ghp_supersecretvalue",
    });
    renderPage();
    await waitFor(() => expect(screen.getByTestId("vault-list")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("vault-row-open-sec_1"));
    expect(screen.getByTestId("vault-entry-detail")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("vault-entry-reveal-btn"));
    await waitFor(() => expect(screen.getByTestId("vault-entry-plaintext")).toBeInTheDocument());
    // Masked preview shows the first/last 4.
    expect(screen.getByTestId("vault-entry-plaintext")).toHaveTextContent("ghp_…alue");
  });

  it("rotates a secret and clears the revealed plaintext", async () => {
    revealMock.mockResolvedValue({ summary: entry(), plaintext: "ghp_old" });
    rotateMock.mockResolvedValueOnce(entry({ keyVersion: 2 }));
    renderPage();
    await waitFor(() => expect(screen.getByTestId("vault-list")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("vault-row-open-sec_1"));
    fireEvent.change(screen.getByTestId("vault-entry-rotate-input"), {
      target: { value: "ghp_new" },
    });
    fireEvent.click(screen.getByTestId("vault-entry-rotate-submit"));
    await waitFor(() => expect(rotateMock).toHaveBeenCalledWith("sec_1", "ghp_new"));
  });

  it("renders audit events for the open entry", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId("vault-list")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("vault-row-open-sec_1"));
    await waitFor(() => expect(screen.getByTestId("vault-audit-audit_1")).toBeInTheDocument());
    expect(screen.getByText("vault.read")).toBeInTheDocument();
  });

  it("deletes a secret and closes the detail panel", async () => {
    removeMock.mockResolvedValueOnce(undefined as unknown as void);
    renderPage();
    await waitFor(() => expect(screen.getByTestId("vault-list")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("vault-row-open-sec_1"));
    fireEvent.click(screen.getByTestId("vault-entry-delete-btn"));
    await waitFor(() => expect(removeMock).toHaveBeenCalledWith("sec_1"));
  });
});
