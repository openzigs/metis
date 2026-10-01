/**
 * Epic #196 / #222 — Vault API client URL + payload tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { vaultApi } from "@/lib/vault-api";
import { apiFetch } from "@/lib/api-client";

vi.mock("@/lib/api-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api-client")>("@/lib/api-client");
  return { ...actual, apiFetch: vi.fn() };
});

const apiFetchMock = vi.mocked(apiFetch);

beforeEach(() => {
  vi.clearAllMocks();
  apiFetchMock.mockResolvedValue({} as never);
});
afterEach(() => {
  vi.clearAllMocks();
});

describe("vaultApi", () => {
  it("list() defaults to no query string", async () => {
    await vaultApi.list();
    expect(apiFetchMock).toHaveBeenCalledWith("/vault");
  });

  it("list() appends a scope filter when provided", async () => {
    await vaultApi.list("project");
    expect(apiFetchMock).toHaveBeenCalledWith("/vault?scope=project");
  });

  it("create() POSTs the body unchanged", async () => {
    await vaultApi.create({ label: "x", value: "y", scope: "global" });
    expect(apiFetchMock).toHaveBeenCalledWith("/vault", {
      method: "POST",
      body: { label: "x", value: "y", scope: "global" },
    });
  });

  it("rotate() puts the value in the body", async () => {
    await vaultApi.rotate("sec_1", "fresh");
    expect(apiFetchMock).toHaveBeenCalledWith("/vault/sec_1/rotate", {
      method: "POST",
      body: { value: "fresh" },
    });
  });

  it("#482 — rotate() sends confirmForeignOwner only when asked to", async () => {
    await vaultApi.rotate("sec_1", "fresh", { confirmForeignOwner: true });
    expect(apiFetchMock).toHaveBeenLastCalledWith("/vault/sec_1/rotate", {
      method: "POST",
      body: { value: "fresh", confirmForeignOwner: true },
    });
    await vaultApi.rotate("sec_1", "fresh", { confirmForeignOwner: false });
    expect(apiFetchMock).toHaveBeenLastCalledWith("/vault/sec_1/rotate", {
      method: "POST",
      body: { value: "fresh" },
    });
  });

  it("#502 — a confirmed rotate() sends the bindings it was shown", async () => {
    const confirmedBindings = [
      { type: "db_connector", id: "db1", destination: "postgres://h", routing: "rt-db1" },
      { type: "mcp_server", id: "m1", destination: null, routing: "rt-m1" },
    ];
    await vaultApi.rotate("sec_1", "fresh", { confirmForeignOwner: true, confirmedBindings });
    expect(apiFetchMock).toHaveBeenLastCalledWith("/vault/sec_1/rotate", {
      method: "POST",
      body: { value: "fresh", confirmForeignOwner: true, confirmedBindings },
    });
    // Bindings are never sent without the confirm they belong to.
    await vaultApi.rotate("sec_1", "fresh", { confirmedBindings });
    expect(apiFetchMock).toHaveBeenLastCalledWith("/vault/sec_1/rotate", {
      method: "POST",
      body: { value: "fresh" },
    });
  });

  it("#611 — a confirmed rotate() can send the list digest instead of the list", async () => {
    const confirmedBindingsDigest = "ab".repeat(32);
    await vaultApi.rotate("sec_1", "fresh", { confirmForeignOwner: true, confirmedBindingsDigest });
    expect(apiFetchMock).toHaveBeenLastCalledWith("/vault/sec_1/rotate", {
      method: "POST",
      body: { value: "fresh", confirmForeignOwner: true, confirmedBindingsDigest },
    });
    // Never sent without the confirm it belongs to.
    await vaultApi.rotate("sec_1", "fresh", { confirmedBindingsDigest });
    expect(apiFetchMock).toHaveBeenLastCalledWith("/vault/sec_1/rotate", {
      method: "POST",
      body: { value: "fresh" },
    });
  });

  it("reveal() hits the canonical reveal path", async () => {
    await vaultApi.reveal("sec_1");
    expect(apiFetchMock).toHaveBeenCalledWith("/vault/sec_1/reveal");
  });

  it("remove() issues a DELETE", async () => {
    await vaultApi.remove("sec_1");
    expect(apiFetchMock).toHaveBeenCalledWith("/vault/sec_1", { method: "DELETE" });
  });

  it("audit() defaults the limit to 50 and clamps via the URL", async () => {
    await vaultApi.audit("sec_1");
    expect(apiFetchMock).toHaveBeenCalledWith("/vault/sec_1/audit?limit=50");
    await vaultApi.audit("sec_1", 25);
    expect(apiFetchMock).toHaveBeenLastCalledWith("/vault/sec_1/audit?limit=25");
  });
});
