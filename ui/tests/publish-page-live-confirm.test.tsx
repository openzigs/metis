/**
 * Publishing page — #1104 findings D, E and F, at the page seam.
 *
 * These assert the properties that matter about the *wiring*, not the markup:
 *
 *   D — `publishingApi.createBatch` (the GitHub-write seam) is not reachable
 *       from one click on "Publish now", and cancelling the confirmation
 *       leaves it uncalled.
 *   E — the batch list is refetched after a publish attempt whether it
 *       succeeded or failed.
 *   F — a stranded `pending` batch can be cleared from the row.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "react";
import { makeWrapper } from "./test-utils";
import { followedRooms } from "@/lib/socket-subscription";
import { publishRoom } from "@metis/shared";
import { createFakeSocket } from "./helpers/fake-socket";
import { useSocket } from "@/lib/socket-client";

vi.mock("next/navigation", async () => {
  const actual = await vi.importActual<typeof import("next/navigation")>("next/navigation");
  return {
    ...actual,
    useParams: vi.fn(() => ({ id: "proj_1" })),
    useSearchParams: vi.fn(() => new URLSearchParams()),
    useRouter: vi.fn(() => ({
      push: vi.fn(),
      replace: vi.fn(),
      refresh: vi.fn(),
      back: vi.fn(),
      forward: vi.fn(),
      prefetch: vi.fn(),
    })),
    usePathname: vi.fn(() => "/"),
  };
});

vi.mock("@/lib/socket-client", () => ({ useSocket: vi.fn(() => null) }));

vi.mock("@/lib/analysis-api", () => ({
  analysisApi: { listForProject: vi.fn().mockResolvedValue({ items: [] }) },
}));

vi.mock("@/lib/publishing-api", () => ({
  publishingApi: {
    listDrafts: vi.fn(),
    listBatches: vi.fn(),
    generateDrafts: vi.fn(),
    approveDraft: vi.fn(),
    createBatch: vi.fn(),
    previewBatch: vi.fn(),
    cancelBatch: vi.fn(),
  },
  reviewGateApi: { get: vi.fn().mockResolvedValue({ requireApprovedReview: false }) },
}));

vi.mock("@/lib/connectors-api", () => ({
  repoConnectorsApi: { getPrimary: vi.fn().mockResolvedValue(null) },
}));

// #980 — the batch secret is chosen from the vault, as on the import form.
vi.mock("@/lib/vault-api", () => ({
  vaultApi: {
    list: vi.fn().mockResolvedValue({ items: [{ id: "v1", label: "gh", description: "" }] }),
  },
}));

import { publishingApi } from "@/lib/publishing-api";
import PublishingPage from "@/app/(authed)/projects/[id]/publish/page";

const mock = (fn: unknown) => fn as unknown as ReturnType<typeof vi.fn>;
const listDrafts = mock(publishingApi.listDrafts);
const listBatches = mock(publishingApi.listBatches);
const createBatch = mock(publishingApi.createBatch);
const previewBatch = mock(publishingApi.previewBatch);
const cancelBatch = mock(publishingApi.cancelBatch);

const DRAFT = {
  id: "draft_aaaaaaaaaa",
  title: "Add OAuth login",
  body: "…",
  draftType: "feature",
  storyPoints: 3,
  status: "approved",
  metadata: null,
};

function makeBatch(over: Record<string, unknown> = {}) {
  return {
    id: "cms3u7y09003g259kej42fn4q",
    projectId: "proj_1",
    status: "pending",
    targetOwner: "openzigs",
    targetRepo: "example-requirements",
    targetBaseUrl: null,
    provider: "github",
    dryRun: false,
    totalDrafts: 14,
    publishedCount: 0,
    failedCount: 0,
    dedupSkipped: 0,
    archived: false,
    archivedAt: null,
    archiveReason: null,
    archivedById: null,
    dryRunPlan: null,
    startedById: "u1",
    startedAt: new Date(Date.now() - 13 * 60 * 60 * 1000).toISOString(),
    completedAt: null,
    errorMessage: null,
    metadata: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over,
  };
}

const PLAN = {
  batchId: "preview-unsaved",
  targetOwner: "openzigs",
  targetRepo: "example-requirements",
  targetBaseUrl: null,
  provider: "github",
  totalActions: 104,
  estimatedDurationMs: 104_000,
  actions: [
    { kind: "issue.create", draftId: "draft_aaaaaaaaaa", title: "Add OAuth login" },
    { kind: "label.upsert", labels: ["metis-generated"] },
  ],
  credentialResolved: true,
  credentialCheck: "resolved",
  credentialErrorCode: null,
};

async function findDraftCheckbox() {
  return screen.findByRole(
    "checkbox",
    { name: `Select draft: ${DRAFT.title}` },
    { timeout: 5_000 },
  );
}

/** Fill in the batch form and arm a LIVE (non-dry-run) publish. */
async function armLivePublish(): Promise<void> {
  const checkbox = await findDraftCheckbox();
  fireEvent.click(checkbox);
  fireEvent.change(screen.getByLabelText("Owner"), { target: { value: "openzigs" } });
  fireEvent.change(screen.getByLabelText("Repo"), {
    target: { value: "example-requirements" },
  });
  await pickVaultSecret("gh");
  fireEvent.click(screen.getByLabelText("Dry run (no GitHub writes)"));
}

/** #980 — choose a vault entry in the batch form's secret picker. */
async function pickVaultSecret(label: string): Promise<void> {
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: "Vault secret ref" }));
  await user.click(await screen.findByRole("option", { name: new RegExp(label) }));
}

function renderPage() {
  const Wrapper = makeWrapper({});
  return render(
    <Wrapper>
      <PublishingPage />
    </Wrapper>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  listDrafts.mockResolvedValue([DRAFT]);
  listBatches.mockResolvedValue([]);
  previewBatch.mockResolvedValue(PLAN);
  createBatch.mockResolvedValue({
    batch: { id: "batch_new_1", dryRunPlan: null },
    run: { status: "completed" },
  });
  cancelBatch.mockResolvedValue(makeBatch({ status: "cancelled" }));
});

describe("D — a live publish requires an explicit confirmation", () => {
  it("clicking 'Publish now' opens a confirmation naming the repo and counts, and writes nothing yet", async () => {
    renderPage();
    await armLivePublish();

    fireEvent.click(screen.getByRole("button", { name: "Publish now" }));

    // The confirming surface names the destination…
    expect(
      await screen.findByRole("heading", { name: /openzigs\/example-requirements/ }),
    ).toBeInTheDocument();
    // …and the action counts, from the plan the server computed.
    await waitFor(() =>
      expect(screen.getByTestId("publish-confirm-total")).toHaveTextContent("104 actions"),
    );
    // Nothing has been written: the publish seam has not been touched.
    expect(createBatch).not.toHaveBeenCalled();
    // The plan preview is the only call made, and it is inert by construction.
    expect(previewBatch).toHaveBeenCalledTimes(1);
  });

  it("cancelling the confirmation performs no GitHub writes", async () => {
    renderPage();
    await armLivePublish();
    fireEvent.click(screen.getByRole("button", { name: "Publish now" }));
    await screen.findByRole("heading", { name: /openzigs\/example-requirements/ });

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() =>
      expect(screen.queryByTestId("publish-confirm-target")).not.toBeInTheDocument(),
    );
    expect(createBatch).not.toHaveBeenCalled();
  });

  it("confirming publishes exactly the batch that was described", async () => {
    renderPage();
    await armLivePublish();
    fireEvent.click(screen.getByRole("button", { name: "Publish now" }));
    await screen.findByTestId("publish-confirm-total");

    fireEvent.click(
      screen.getByRole("button", { name: /Publish to openzigs\/example-requirements/ }),
    );

    await waitFor(() => expect(createBatch).toHaveBeenCalledTimes(1));
    expect(createBatch.mock.calls[0][1]).toMatchObject({
      targetOwner: "openzigs",
      targetRepo: "example-requirements",
      dryRun: false,
      secretRef: "${vault:gh}", // #980 — picked from the vault
      draftIds: [DRAFT.id],
    });
    // Same destination and draft set as the plan that was previewed.
    expect(previewBatch.mock.calls[0][1]).toMatchObject({
      targetOwner: "openzigs",
      targetRepo: "example-requirements",
      draftIds: [DRAFT.id],
    });
  });

  it("a dry run still runs on one click — the gate is only for real writes", async () => {
    renderPage();
    const checkbox = await findDraftCheckbox();
    fireEvent.click(checkbox);
    fireEvent.change(screen.getByLabelText("Owner"), { target: { value: "openzigs" } });
    fireEvent.change(screen.getByLabelText("Repo"), {
      target: { value: "example-requirements" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Run dry-run" }));

    await waitFor(() => expect(createBatch).toHaveBeenCalledTimes(1));
    expect(createBatch.mock.calls[0][1]).toMatchObject({ dryRun: true });
    expect(previewBatch).not.toHaveBeenCalled();
  });
});

describe("E — the batch list refetches after a publish attempt", () => {
  it("refetches after a REJECTED publish", async () => {
    createBatch.mockRejectedValue(new Error("promotion blocked"));
    renderPage();
    await armLivePublish();
    await waitFor(() => expect(listBatches).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "Publish now" }));
    await screen.findByTestId("publish-confirm-total");
    // The server records a `failed` row even for a rejected publish…
    listBatches.mockResolvedValue([makeBatch({ status: "failed" })]);
    fireEvent.click(screen.getByRole("button", { name: /Publish to openzigs/ }));

    await waitFor(() => expect(createBatch).toHaveBeenCalled());
    // …so the panel must show it without a manual reload.
    await waitFor(() => expect(listBatches.mock.calls.length).toBeGreaterThan(1));
    expect(await screen.findByText("failed")).toBeInTheDocument();
  });

  it("refetches after a SUCCESSFUL publish", async () => {
    renderPage();
    await armLivePublish();
    await waitFor(() => expect(listBatches).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "Publish now" }));
    await screen.findByTestId("publish-confirm-total");
    listBatches.mockResolvedValue([makeBatch({ status: "completed" })]);
    fireEvent.click(screen.getByRole("button", { name: /Publish to openzigs/ }));

    await waitFor(() => expect(listBatches.mock.calls.length).toBeGreaterThan(1));
  });
});

describe("F — a stranded pending batch can be cleared", () => {
  it("offers Cancel on the stranded row and settles it without a reload", async () => {
    listBatches.mockResolvedValue([makeBatch()]);
    renderPage();

    const button = await screen.findByTestId("cancel-batch-cms3u7y09003g259kej42fn4q");
    expect(button).toBeEnabled();

    listBatches.mockResolvedValue([makeBatch({ status: "cancelled" })]);
    fireEvent.click(button);

    await waitFor(() =>
      expect(cancelBatch).toHaveBeenCalledWith("proj_1", "cms3u7y09003g259kej42fn4q"),
    );
    expect(await screen.findByText("cancelled")).toBeInTheDocument();
  });

  it("does not offer Cancel for a batch that may still be in flight", async () => {
    listBatches.mockResolvedValue([
      makeBatch({ status: "running", startedAt: new Date().toISOString() }),
    ]);
    renderPage();

    const button = await screen.findByTestId("cancel-batch-cms3u7y09003g259kej42fn4q");
    expect(button).toBeDisabled();
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByText("running")).toBeInTheDocument());
    expect(cancelBatch).not.toHaveBeenCalled();
  });
});

describe("#642 — a watched batch keeps its live log across a reconnect", () => {
  it("re-joins the publish room on reconnect and keeps appending events", async () => {
    const socket = createFakeSocket();
    vi.mocked(useSocket).mockReturnValue(socket as never);
    listBatches.mockResolvedValue([makeBatch()]);
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Watch" }));
    const room = { batchId: "cms3u7y09003g259kej42fn4q" };
    await waitFor(() => expect(socket.emitted("subscribe:publish", room)).toBe(1));
    // #672 — counted under the server's room name, not a hand-typed key.
    expect(followedRooms(socket as never)).toEqual(new Map([[publishRoom(room.batchId), 1]]));

    act(() => socket.reconnect());
    expect(socket.emitted("subscribe:publish", room)).toBe(2);

    act(() => socket.fire("publish:status", { status: "running", message: "after reconnect" }));
    expect(await screen.findByText(/\[running\] after reconnect/)).toBeInTheDocument();
  });
});

describe("#642 — ending a watch releases the publish room", () => {
  const ROOM_A = { batchId: "cms3u7y09003g259kej42fn4q" };
  const ROOM_B = { batchId: "cms3u7y09003g259kej42zzzz" };

  async function watchFirstBatch(socket: ReturnType<typeof createFakeSocket>) {
    vi.mocked(useSocket).mockReturnValue(socket as never);
    listBatches.mockResolvedValue([makeBatch()]);
    const view = renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Watch" }));
    await waitFor(() => expect(socket.emitted("subscribe:publish", ROOM_A)).toBe(1));
    return view;
  }

  it("Close unsubscribes the watched batch once and a later reconnect does not re-join it", async () => {
    const socket = createFakeSocket();
    await watchFirstBatch(socket);

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    await waitFor(() => expect(socket.emitted("unsubscribe:publish", ROOM_A)).toBe(1));
    act(() => socket.reconnect());
    expect(socket.emitted("subscribe:publish", ROOM_A)).toBe(1);
    expect(socket.emitted("unsubscribe:publish", ROOM_A)).toBe(1);
  });

  it("unmounting the page unsubscribes the watched batch once and a later reconnect does not re-join it", async () => {
    const socket = createFakeSocket();
    const view = await watchFirstBatch(socket);

    view.unmount();

    expect(socket.emitted("unsubscribe:publish", ROOM_A)).toBe(1);
    act(() => socket.reconnect());
    expect(socket.emitted("subscribe:publish", ROOM_A)).toBe(1);
    expect(socket.emitted("unsubscribe:publish", ROOM_A)).toBe(1);
  });

  it("switching to another batch unsubscribes the old one and re-joins only the new one on reconnect", async () => {
    const socket = createFakeSocket();
    vi.mocked(useSocket).mockReturnValue(socket as never);
    listBatches.mockResolvedValue([makeBatch(), makeBatch({ id: ROOM_B.batchId })]);
    renderPage();

    await waitFor(() => expect(screen.getAllByRole("button", { name: "Watch" })).toHaveLength(2));
    const watchButtons = screen.getAllByRole("button", { name: "Watch" });
    fireEvent.click(watchButtons[0]);
    await waitFor(() => expect(socket.emitted("subscribe:publish")).toBe(1));
    // Row order is the table's concern; read which batch the first Watch joined.
    const first = socket.emitted("subscribe:publish", ROOM_A) === 1 ? ROOM_A : ROOM_B;
    const second = first === ROOM_A ? ROOM_B : ROOM_A;

    fireEvent.click(watchButtons[1]);
    await waitFor(() => expect(socket.emitted("subscribe:publish", second)).toBe(1));
    expect(socket.emitted("unsubscribe:publish", first)).toBe(1);
    expect(socket.emitted("unsubscribe:publish", second)).toBe(0);

    act(() => socket.reconnect());
    expect(socket.emitted("subscribe:publish", first)).toBe(1);
    expect(socket.emitted("subscribe:publish", second)).toBe(2);
  });
});

describe("#646 — a watched batch reconciles events missed while disconnected", () => {
  it("re-reads the batches on reconnect, so a batch that finished in the gap shows it", async () => {
    const socket = createFakeSocket();
    vi.mocked(useSocket).mockReturnValue(socket as never);
    listBatches.mockResolvedValue([makeBatch({ status: "running" })]);
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Watch" }));
    const room = { batchId: "cms3u7y09003g259kej42fn4q" };
    await waitFor(() => expect(socket.emitted("subscribe:publish", room)).toBe(1));
    const readsBefore = listBatches.mock.calls.length;

    act(() => socket.disconnect());
    // The `publish:completed` is emitted now — and lost.
    listBatches.mockResolvedValue([
      makeBatch({ status: "completed", publishedCount: 14, completedAt: new Date().toISOString() }),
    ]);
    act(() => socket.connect());

    await waitFor(() => expect(listBatches.mock.calls.length).toBe(readsBefore + 1));
    expect(await screen.findByText("completed")).toBeInTheDocument();
  });
});
