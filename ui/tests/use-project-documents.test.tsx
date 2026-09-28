/**
 * #322 — `useProjectDocuments`: the project documents query that keeps itself
 * fresh while any document is still ingesting.
 *
 * The Analysis page read the documents list once and only re-read it right
 * after an upload. Ingest is queued, so that one read usually still saw the
 * new document `pending`; nothing read it again, and its checkbox stayed
 * disabled until a full page reload (the e2e "auto-selects when ready" flake).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { makeWrapper } from "./test-utils";

const { socketStub } = vi.hoisted(() => ({
  socketStub: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
}));

vi.mock("@/lib/socket-client", () => ({
  useSocket: () => socketStub,
}));

vi.mock("@/lib/projects-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/projects-api")>("@/lib/projects-api");
  return { ...actual, documentsApi: { ...actual.documentsApi, list: vi.fn() } };
});

import { documentsApi } from "@/lib/projects-api";
import { DOCUMENT_INGEST_POLL_MS, useProjectDocuments } from "@/hooks/use-project-documents";

const list = documentsApi.list as unknown as ReturnType<typeof vi.fn>;

function doc(id: string, status: string, indexState: string | null = null) {
  return { id, filename: `${id}.md`, status, indexState };
}

function page(...items: ReturnType<typeof doc>[]) {
  return { items, total: items.length, limit: 25, offset: 0 };
}

function renderDocs(projectId = "p1") {
  const Wrapper = makeWrapper({});
  return renderHook(() => useProjectDocuments(projectId), { wrapper: Wrapper });
}

beforeEach(() => {
  list.mockReset();
  socketStub.on.mockReset();
  socketStub.off.mockReset();
  socketStub.emit.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useProjectDocuments", () => {
  it("re-reads the list until an ingesting document turns ready", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    list
      .mockResolvedValueOnce(page(doc("d1", "pending")))
      .mockResolvedValueOnce(page(doc("d1", "processing")))
      .mockResolvedValue(page(doc("d1", "ready")));
    const { result } = renderDocs();
    await waitFor(() => expect(result.current.data?.items[0]?.status).toBe("pending"));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(DOCUMENT_INGEST_POLL_MS);
    });
    await waitFor(() => expect(result.current.data?.items[0]?.status).toBe("processing"));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(DOCUMENT_INGEST_POLL_MS);
    });
    await waitFor(() => expect(result.current.data?.items[0]?.status).toBe("ready"));

    // Settled: nothing is ingesting, so the poll stops.
    const calls = list.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DOCUMENT_INGEST_POLL_MS * 3);
    });
    expect(list).toHaveBeenCalledTimes(calls);
  });

  it("does not poll a settled list or one only awaiting review", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // A quarantined document keeps `status = processing` but is waiting for a
    // reviewer, not ingesting (#69) — polling it would never end.
    list.mockResolvedValue(page(doc("d1", "ready"), doc("d2", "processing", "quarantined")));
    const { result } = renderDocs();
    await waitFor(() => expect(result.current.data?.items).toHaveLength(2));
    expect(list).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(DOCUMENT_INGEST_POLL_MS * 3);
    });
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("subscribes to the project and re-reads on its document:status push", async () => {
    list
      .mockResolvedValueOnce(page(doc("d1", "pending")))
      .mockResolvedValue(page(doc("d1", "ready")));
    const { result, unmount } = renderDocs("p1");
    await waitFor(() => expect(result.current.data?.items[0]?.status).toBe("pending"));

    expect(socketStub.emit).toHaveBeenCalledWith("subscribe:project", { projectId: "p1" });
    const handler = socketStub.on.mock.calls.find(([event]) => event === "document:status")?.[1] as
      ((data: { projectId: string }) => void) | undefined;
    expect(handler).toBeTypeOf("function");

    // Another project's event is ignored.
    act(() => handler!({ projectId: "other" }));
    expect(list).toHaveBeenCalledTimes(1);

    act(() => handler!({ projectId: "p1" }));
    await waitFor(() => expect(result.current.data?.items[0]?.status).toBe("ready"));

    unmount();
    expect(socketStub.off).toHaveBeenCalledWith("document:status", handler);
  });
});
