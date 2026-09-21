/**
 * Issue #129 — products-api client unit tests.
 *
 * Mocks apiFetch and asserts each method's URL / method / body and that error
 * propagation is left to apiFetch (which returns parsed error messages).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const mockApiFetch = vi.fn();
vi.mock("@/lib/api-client", () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

const { productsApi } = await import("../src/lib/products-api");

beforeEach(() => mockApiFetch.mockReset());

describe("productsApi", () => {
  it("list passes params", async () => {
    mockApiFetch.mockResolvedValue({ items: [], total: 0 });
    await productsApi.list({ search: "x", limit: 10, offset: 0 });
    expect(mockApiFetch).toHaveBeenCalledWith("/products", {
      params: { search: "x", limit: 10, offset: 0 },
    });
  });

  it("get fetches by id", async () => {
    mockApiFetch.mockResolvedValue({ id: "p1" });
    await productsApi.get("p1");
    expect(mockApiFetch).toHaveBeenCalledWith("/products/p1");
  });

  it("create POSTs the body", async () => {
    mockApiFetch.mockResolvedValue({ id: "p1" });
    await productsApi.create({ name: "Demo", slug: "demo" });
    expect(mockApiFetch).toHaveBeenCalledWith("/products", {
      method: "POST",
      body: { name: "Demo", slug: "demo" },
    });
  });

  it("update PATCHes the body", async () => {
    mockApiFetch.mockResolvedValue({ id: "p1" });
    await productsApi.update("p1", { name: "New" });
    expect(mockApiFetch).toHaveBeenCalledWith("/products/p1", {
      method: "PATCH",
      body: { name: "New" },
    });
  });

  it("delete DELETEs by id", async () => {
    mockApiFetch.mockResolvedValue(undefined);
    await productsApi.delete("p1");
    expect(mockApiFetch).toHaveBeenCalledWith("/products/p1", { method: "DELETE" });
  });

  it("addRepo POSTs to the repos collection", async () => {
    mockApiFetch.mockResolvedValue({ id: "pr1" });
    await productsApi.addRepo("p1", { repoConnectionId: "rc1", role: "primary" });
    expect(mockApiFetch).toHaveBeenCalledWith("/products/p1/repos", {
      method: "POST",
      body: { repoConnectionId: "rc1", role: "primary" },
    });
  });

  it("removeRepo DELETEs a repo link", async () => {
    mockApiFetch.mockResolvedValue(undefined);
    await productsApi.removeRepo("p1", "rc1");
    expect(mockApiFetch).toHaveBeenCalledWith("/products/p1/repos/rc1", { method: "DELETE" });
  });

  it("updateRepo PATCHes the role", async () => {
    mockApiFetch.mockResolvedValue({ id: "pr1" });
    await productsApi.updateRepo("p1", "rc1", { role: "secondary" });
    expect(mockApiFetch).toHaveBeenCalledWith("/products/p1/repos/rc1", {
      method: "PATCH",
      body: { role: "secondary" },
    });
  });

  it("analyze POSTs to the analyze endpoint", async () => {
    mockApiFetch.mockResolvedValue({ analysisId: "a1", status: "queued" });
    await productsApi.analyze("p1");
    expect(mockApiFetch).toHaveBeenCalledWith("/products/p1/analyze", { method: "POST" });
  });

  it("getDocuments passes the docType param when provided", async () => {
    mockApiFetch.mockResolvedValue([]);
    await productsApi.getDocuments("p1", "architecture");
    expect(mockApiFetch).toHaveBeenCalledWith("/products/p1/documents", {
      params: { docType: "architecture" },
    });
  });

  it("getDocuments omits params when no docType", async () => {
    mockApiFetch.mockResolvedValue([]);
    await productsApi.getDocuments("p1");
    expect(mockApiFetch).toHaveBeenCalledWith("/products/p1/documents", { params: undefined });
  });

  it("getAnalyses fetches the analyses list", async () => {
    mockApiFetch.mockResolvedValue([]);
    await productsApi.getAnalyses("p1");
    expect(mockApiFetch).toHaveBeenCalledWith("/products/p1/analyses");
  });

  it("listRepoConnections passes a search param when provided", async () => {
    mockApiFetch.mockResolvedValue([]);
    await productsApi.listRepoConnections("foo");
    expect(mockApiFetch).toHaveBeenCalledWith("/products/repo-connections", {
      params: { search: "foo" },
    });
  });

  it("propagates errors from apiFetch", async () => {
    mockApiFetch.mockRejectedValueOnce(new Error("network down"));
    await expect(productsApi.get("p1")).rejects.toThrow("network down");
  });
});
