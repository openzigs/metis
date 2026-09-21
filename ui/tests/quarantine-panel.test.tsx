/**
 * Epic #157 — Quarantine panel tests.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QuarantinePanel } from "@/components/projects/quarantine-panel";
import { makeWrapper } from "./test-utils";

vi.mock("@/lib/projects-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/projects-api")>("@/lib/projects-api");
  return {
    ...actual,
    quarantineApi: {
      list: vi.fn(),
      approve: vi.fn(),
      reject: vi.fn(),
      setDocAutoApprove: vi.fn(),
      setProjectAutoApprove: vi.fn(),
    },
  };
});

import { quarantineApi } from "@/lib/projects-api";

const mocks = quarantineApi as {
  list: ReturnType<typeof vi.fn>;
  approve: ReturnType<typeof vi.fn>;
  reject: ReturnType<typeof vi.fn>;
  setDocAutoApprove: ReturnType<typeof vi.fn>;
  setProjectAutoApprove: ReturnType<typeof vi.fn>;
};

const sampleRow = {
  documentId: "doc_1",
  filename: "spec.md",
  uploadedAt: new Date().toISOString(),
  chunkCount: 12,
  indexState: "quarantined" as const,
  autoApproveTrusted: false,
};

const reconcilingRow = {
  ...sampleRow,
  indexState: "reconciling" as const,
  errorMessage: "Index cleanup failed",
};

beforeEach(() => {
  mocks.list.mockReset();
  mocks.approve.mockReset();
  mocks.reject.mockReset();
  mocks.setDocAutoApprove.mockReset();
  mocks.setProjectAutoApprove.mockReset();
});

function renderPanel() {
  const Wrapper = makeWrapper({});
  return render(
    <Wrapper>
      <QuarantinePanel projectId="proj_1" />
    </Wrapper>,
  );
}

describe("QuarantinePanel", () => {
  it("renders an empty quarantine state", async () => {
    mocks.list.mockResolvedValue({ items: [], autoApproveTrustedSources: false });
    renderPanel();
    await waitFor(() => expect(mocks.list).toHaveBeenCalled());
    expect(await screen.findByText(/Quarantine is empty/i)).toBeInTheDocument();
  });

  it("renders rows with approve / reject controls", async () => {
    mocks.list.mockResolvedValue({
      items: [sampleRow],
      autoApproveTrustedSources: false,
    });
    renderPanel();
    expect(await screen.findByTestId("quarantine-row-doc_1")).toBeInTheDocument();
    expect(screen.getByTestId("approve-doc_1")).toBeInTheDocument();
    expect(screen.getByTestId("reject-doc_1")).toBeInTheDocument();
  });

  it("calls approve on click", async () => {
    mocks.list.mockResolvedValue({
      items: [sampleRow],
      autoApproveTrustedSources: false,
    });
    mocks.approve.mockResolvedValue({});
    renderPanel();
    fireEvent.click(await screen.findByTestId("approve-doc_1"));
    await waitFor(() => expect(mocks.approve).toHaveBeenCalledWith("proj_1", "doc_1"));
  });

  it("calls reject on click", async () => {
    mocks.list.mockResolvedValue({
      items: [sampleRow],
      autoApproveTrustedSources: false,
    });
    mocks.reject.mockResolvedValue({});
    renderPanel();
    fireEvent.click(await screen.findByTestId("reject-doc_1"));
    await waitFor(() => expect(mocks.reject).toHaveBeenCalledWith("proj_1", "doc_1"));
  });

  it("toggles project-wide auto-approve", async () => {
    mocks.list.mockResolvedValue({ items: [], autoApproveTrustedSources: false });
    mocks.setProjectAutoApprove.mockResolvedValue({});
    renderPanel();
    const toggle = (await screen.findByTestId("project-auto-approve")) as HTMLInputElement;
    fireEvent.click(toggle);
    await waitFor(() => expect(mocks.setProjectAutoApprove).toHaveBeenCalledWith("proj_1", true));
  });

  it("shows saved reconciliation and Retry indexing after a fresh reload, without reject or trust", async () => {
    mocks.list.mockResolvedValue({ items: [reconcilingRow], autoApproveTrustedSources: false });
    const first = renderPanel();
    expect(await screen.findByRole("button", { name: "Retry indexing" })).toBeEnabled();
    expect(screen.getByText("Index cleanup failed")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reject" })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("checkbox", { name: "Auto-approve spec.md" }),
    ).not.toBeInTheDocument();
    first.unmount();
    renderPanel(); // New QueryClient, no mutation state or cached rows.
    expect(await screen.findByRole("button", { name: "Retry indexing" })).toBeEnabled();
    expect(screen.getByText(/Approval saved/)).toBeInTheDocument();
    expect(mocks.approve).not.toHaveBeenCalled();
  });

  it.each(["doc_1", "gendoc-doc:revision-1"])(
    "retries %s through the existing approval API, disables duplicate clicks, and removes a recovered row",
    async (documentId) => {
      mocks.list.mockResolvedValue({
        items: [{ ...reconcilingRow, documentId }],
        autoApproveTrustedSources: false,
      });
      let finish!: () => void;
      mocks.approve.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      );
      renderPanel();
      fireEvent.click(await screen.findByRole("button", { name: "Retry indexing" }));
      await waitFor(() => expect(mocks.approve).toHaveBeenCalledWith("proj_1", documentId));
      expect(await screen.findByRole("button", { name: "Retrying indexing…" })).toBeDisabled();
      fireEvent.click(screen.getByRole("button", { name: "Retrying indexing…" }));
      expect(mocks.approve).toHaveBeenCalledTimes(1);
      mocks.list.mockResolvedValue({ items: [], autoApproveTrustedSources: false });
      finish();
      expect(await screen.findByText("Quarantine is empty.")).toBeInTheDocument();
    },
  );

  it("refreshes after a failed initial approval to expose the committed reconciliation state", async () => {
    mocks.list
      .mockResolvedValueOnce({ items: [sampleRow], autoApproveTrustedSources: false })
      .mockResolvedValue({ items: [reconcilingRow], autoApproveTrustedSources: false });
    mocks.approve.mockRejectedValue(new Error("Approval cleanup failed"));
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    expect(await screen.findByRole("button", { name: "Retry indexing" })).toBeEnabled();
    expect(await screen.findByRole("alert")).toHaveTextContent("Approval cleanup failed");
    expect(screen.queryByRole("button", { name: "Reject" })).not.toBeInTheDocument();
  });

  it("keeps a failed retry visible and allows retrying again after a permission error", async () => {
    mocks.list.mockResolvedValue({ items: [reconcilingRow], autoApproveTrustedSources: false });
    mocks.approve.mockRejectedValueOnce(new Error("Permission denied"));
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Retry indexing" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Permission denied");
    expect(screen.getByRole("button", { name: "Retry indexing" })).toBeEnabled();
    expect(screen.getByText("spec.md")).toBeInTheDocument();
    mocks.list.mockResolvedValue({ items: [], autoApproveTrustedSources: false });
    mocks.approve.mockResolvedValue({});
    fireEvent.click(screen.getByRole("button", { name: "Retry indexing" }));
    expect(await screen.findByText("Quarantine is empty.")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(mocks.approve).toHaveBeenCalledTimes(2);
  });

  it("shows list failures rather than an empty quarantine and lets the user reload", async () => {
    mocks.list.mockRejectedValueOnce(new Error("List unavailable"));
    renderPanel();
    expect(await screen.findByRole("alert")).toHaveTextContent("List unavailable");
    expect(screen.queryByText("Quarantine is empty.")).not.toBeInTheDocument();
    mocks.list.mockResolvedValue({ items: [reconcilingRow], autoApproveTrustedSources: false });
    fireEvent.click(screen.getByRole("button", { name: "Retry loading quarantine" }));
    expect(await screen.findByRole("button", { name: "Retry indexing" })).toBeEnabled();
  });
});
