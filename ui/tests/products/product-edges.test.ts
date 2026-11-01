/**
 * #1628 — the pure half of the declared-edge editor, and the requests the
 * products client sends for it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  confidenceLabel,
  declareEdgeBody,
  draftFromEdge,
  edgeDraftError,
  edgeTargetLabel,
  emptyEdgeDraft,
  filterEdgesByKind,
  isDeclaredEdge,
  originLabel,
  repoLabel,
  updateEdgeBody,
} from "@/lib/product-edges";
import { productsApi } from "@/lib/products-api";
import {
  REPO_A,
  REPO_B,
  declaredEdge,
  detectedEdge,
  edge,
  idp,
  product,
} from "./product-edges-fixtures";

describe("filterEdgesByKind", () => {
  const legacy = edge({ id: "edge-legacy01", integrationKind: null });
  const all = [detectedEdge, declaredEdge, legacy];

  it("keeps every edge, an unclassified one included, for 'all'", () => {
    expect(filterEdgesByKind(all, "all")).toEqual(all);
  });

  it("keeps only the edges of one kind", () => {
    expect(filterEdgesByKind(all, "identity")).toEqual([declaredEdge]);
    expect(filterEdgesByKind(all, "api")).toEqual([detectedEdge]);
    expect(filterEdgesByKind(all, "event")).toEqual([]);
  });
});

describe("isDeclaredEdge", () => {
  it.each([
    ["declared", true],
    ["detected", false],
    ["overridden", false],
    ["something-new", false],
  ])("%s -> %s", (origin, expected) => {
    expect(isDeclaredEdge({ origin: origin as never })).toBe(expected);
  });
});

describe("edge drafts", () => {
  it("starts a blank draft at the first repo with no target or resource", () => {
    expect(emptyEdgeDraft(REPO_A)).toMatchObject({
      sourceRepoId: REPO_A,
      targetRepoId: "",
      resourceId: "",
    });
  });

  it("reads a draft off an edge, nulls as none", () => {
    expect(draftFromEdge(declaredEdge)).toEqual({
      sourceRepoId: REPO_B,
      targetRepoId: "",
      resourceId: idp.id,
      edgeType: "consumes",
      integrationKind: "identity",
      strength: "functional",
      direction: "depends-on",
    });
  });

  it("starts an unclassified edge at the blank draft's classification", () => {
    const d = draftFromEdge(edge({ integrationKind: null, strength: null, direction: null }));
    expect(d).toMatchObject({
      integrationKind: "api",
      strength: "contract",
      direction: "consumes",
    });
  });

  it("refuses a draft with no source, with neither target nor resource, or to itself", () => {
    expect(edgeDraftError({ ...emptyEdgeDraft(""), targetRepoId: REPO_B })).toMatch(/starts from/);
    expect(edgeDraftError(emptyEdgeDraft(REPO_A))).toMatch(/target repository, a shared resource/);
    expect(edgeDraftError({ ...emptyEdgeDraft(REPO_A), targetRepoId: REPO_A })).toMatch(/itself/);
  });

  it("accepts a draft to a repo, through a resource, or both", () => {
    expect(edgeDraftError({ ...emptyEdgeDraft(REPO_A), targetRepoId: REPO_B })).toBeNull();
    expect(edgeDraftError({ ...emptyEdgeDraft(REPO_A), resourceId: idp.id })).toBeNull();
  });

  it("sends none as null and the source on create only", () => {
    const d = { ...emptyEdgeDraft(REPO_A), resourceId: idp.id };
    expect(declareEdgeBody(d)).toEqual({
      sourceRepoId: REPO_A,
      targetRepoId: null,
      resourceId: idp.id,
      edgeType: "calls",
      integrationKind: "api",
      strength: "contract",
      direction: "consumes",
    });
    const patch = updateEdgeBody({ ...d, targetRepoId: REPO_B, resourceId: "" });
    expect(patch).not.toHaveProperty("sourceRepoId");
    expect(patch).not.toHaveProperty("contractDocId");
    expect(patch).toMatchObject({ targetRepoId: REPO_B, resourceId: null });
  });
});

describe("labels", () => {
  const p = product();

  it("names a repo owner/name, or by id when it has no connection row", () => {
    expect(repoLabel(p, REPO_A)).toBe("acme/checkout");
    expect(repoLabel(p, "rc-unknown01")).toBe("rc-unknown01");
  });

  it("names the far end: a repo, a resource, or both", () => {
    expect(edgeTargetLabel(p, [idp], detectedEdge)).toBe("acme/ledger");
    expect(edgeTargetLabel(p, [idp], declaredEdge)).toBe("Okta (identity-provider)");
    expect(edgeTargetLabel(p, [idp], { targetRepoId: REPO_B, resourceId: idp.id })).toBe(
      "acme/ledger via Okta (identity-provider)",
    );
    expect(edgeTargetLabel(p, [], { targetRepoId: null, resourceId: "res-gone0001" })).toBe(
      "res-gone0001",
    );
  });

  it("shows confidence as a percentage and origin in words", () => {
    expect(confidenceLabel(0.724)).toBe("72%");
    expect(confidenceLabel(1)).toBe("100%");
    expect(originLabel("overridden")).toBe("Detected (overridden)");
    expect(originLabel("detected")).toBe("Detected");
    expect(originLabel("mystery")).toBe("mystery");
  });
});

describe("productsApi edge requests (#1628)", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  function ok(data: unknown, status = 200) {
    return new Response(status === 204 ? null : JSON.stringify({ success: true, data }), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  it.each([
    [
      "declareEdge",
      () =>
        productsApi.declareEdge(
          "p/1",
          declareEdgeBody({ ...emptyEdgeDraft(REPO_A), targetRepoId: REPO_B }),
        ),
      "/api/products/p%2F1/edges",
      "POST",
    ],
    [
      "updateEdge",
      () => productsApi.updateEdge("p1", "e/1", { strength: "intrusive" }),
      "/api/products/p1/edges/e%2F1",
      "PATCH",
    ],
    ["deleteEdge", () => productsApi.deleteEdge("p1", "e1"), "/api/products/p1/edges/e1", "DELETE"],
    [
      "declareResource",
      () => productsApi.declareResource("p1", { kind: "bucket", name: "drops" }),
      "/api/products/p1/resources",
      "POST",
    ],
  ])("%s sends %s %s", async (_name, call, url, method) => {
    fetchMock.mockResolvedValue(method === "DELETE" ? ok(null, 204) : ok({ id: "x" }));
    await call();
    const [calledUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe(url);
    expect(init.method).toBe(method);
  });

  it("sends the edge body as JSON", async () => {
    fetchMock.mockResolvedValue(ok({ id: "x" }));
    await productsApi.updateEdge("p1", "e1", { strength: "intrusive" });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ strength: "intrusive" });
  });
});
