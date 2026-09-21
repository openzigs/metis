import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiFetch = vi.fn();
const streamFetch = vi.fn();

vi.mock("@/lib/api-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api-client")>("@/lib/api-client");
  return {
    ...actual,
    apiFetch: (...args: unknown[]) => apiFetch(...args),
    streamFetch: (...args: unknown[]) => streamFetch(...args),
  };
});

import { historyApi } from "@/lib/history-api";
import { ApiError } from "@/lib/api-client";

describe("historyApi.list", () => {
  beforeEach(() => {
    apiFetch.mockReset();
    streamFetch.mockReset();
  });

  it("requests the history endpoint with paging params", async () => {
    apiFetch.mockResolvedValue({ versions: [], total: 0, page: 2, pageSize: 5, currentVersion: 0 });
    await historyApi.list("req-1", { page: 2, pageSize: 5 });
    expect(apiFetch).toHaveBeenCalledWith("/requirements/req-1/history", {
      params: { page: 2, pageSize: 5 },
    });
  });

  it("defaults to page 1 / pageSize 20", async () => {
    apiFetch.mockResolvedValue({
      versions: [],
      total: 0,
      page: 1,
      pageSize: 20,
      currentVersion: 0,
    });
    await historyApi.list("req-1");
    expect(apiFetch).toHaveBeenCalledWith("/requirements/req-1/history", {
      params: { page: 1, pageSize: 20 },
    });
  });
});

describe("historyApi.restore", () => {
  beforeEach(() => {
    apiFetch.mockReset();
  });

  it("posts an empty body when no reason given", async () => {
    apiFetch.mockResolvedValue({ id: "req-1", version: 4, restoredFrom: 2 });
    await historyApi.restore("req-1", 2);
    expect(apiFetch).toHaveBeenCalledWith("/requirements/req-1/restore/2", {
      method: "POST",
      body: {},
    });
  });

  it("includes the reason when provided", async () => {
    apiFetch.mockResolvedValue({ id: "req-1", version: 4, restoredFrom: 2 });
    await historyApi.restore("req-1", 2, "rollback");
    expect(apiFetch).toHaveBeenCalledWith("/requirements/req-1/restore/2", {
      method: "POST",
      body: { reason: "rollback" },
    });
  });
});

describe("historyApi.export", () => {
  const createObjectURL = vi.fn(() => "blob:fake");
  const revokeObjectURL = vi.fn();
  let clickSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    streamFetch.mockReset();
    createObjectURL.mockClear();
    revokeObjectURL.mockClear();
    (URL as unknown as { createObjectURL: unknown }).createObjectURL = createObjectURL;
    (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = revokeObjectURL;
    // Intercept anchor clicks so jsdom doesn't attempt a navigation.
    clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("downloads a CSV blob with the expected filename", async () => {
    streamFetch.mockResolvedValue({
      ok: true,
      blob: () => Promise.resolve(new Blob(["a,b"], { type: "text/csv" })),
    });
    await historyApi.export("req-9", "csv");
    expect(streamFetch).toHaveBeenCalledWith("/requirements/req-9/history/export", {
      params: { format: "csv" },
    });
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(clickSpy).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:fake");
  });

  it("throws an ApiError when the response is not ok", async () => {
    streamFetch.mockResolvedValue({
      ok: false,
      status: 500,
      blob: () => Promise.resolve(new Blob()),
    });
    await expect(historyApi.export("req-9", "json")).rejects.toBeInstanceOf(ApiError);
  });
});
