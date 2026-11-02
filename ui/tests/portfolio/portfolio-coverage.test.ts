/**
 * #1626 — the coverage page's words for a reader's view: one row per product
 * in scope, the reason a product was not checked, repo-stamped citations and
 * the one-sentence answer.
 */
import { describe, expect, it } from "vitest";
import { coverageHeadline, coverageRows, storedRepos } from "@/lib/portfolio-coverage";
import { fiveStates, product, repo, repoDetail, view } from "./fixtures";

describe("coverageRows", () => {
  it("lists every product in scope, in scope order, each with its state", () => {
    const rows = coverageRows(fiveStates());
    expect(rows.map((r) => [r.productId, r.coverage])).toEqual([
      ["p-billing", "covers"],
      ["p-ledger", "partial"],
      ["p-crm", "not-covered"],
      ["p-hr", "not-checked"],
      ["p-secret", "restricted"],
    ]);
  });

  it("stamps each citation with its repo: the citation's own, else the verdict's", () => {
    const billing = coverageRows(fiveStates())[0];
    expect(billing.citations).toEqual([
      { repo: "acme/payments", location: "src/transfer.ts:42" },
      { repo: "acme/payments", location: "src/iban.ts:7" },
    ]);
  });

  it("names a citation in a repo with no stored label as unnamed, not by its id", () => {
    const v = view({
      productIds: ["p"],
      products: [product("p", "covers", repoDetail([]))],
      repos: [repo("p", "r-x", "implemented", [{ filePath: "a.ts", startLine: 1 }])],
    });
    expect(coverageRows(v)[0].citations).toEqual([
      { repo: "Unnamed repository", location: "a.ts:1" },
    ]);
  });

  it("carries nothing for a restricted product: no name, no citations", () => {
    const v = fiveStates();
    // Even if a citation for it were present, it is not shown.
    v.repos.push(repo("p-secret", "r-s", "implemented", [{ filePath: "s.ts", startLine: 1 }]));
    v.productNames["p-secret"] = "Secret";
    expect(coverageRows(v)[4]).toEqual({
      productId: "p-secret",
      name: null,
      coverage: "restricted",
      reason: null,
      coveringRepos: [],
      citations: [],
    });
  });

  it("gives the stored reason a product was not checked", () => {
    expect(coverageRows(fiveStates())[3].reason).toBe("it has no repositories attached");
    const v = view({
      productIds: ["a", "b", "c"],
      products: [
        product("a", "not-checked", repoDetail([], "repos-restricted")),
        product("b", "not-checked", repoDetail([], "could-not-verify")),
        product("c", "not-checked", { reason: "something-new" }),
      ],
    });
    expect(coverageRows(v).map((r) => r.reason)).toEqual([
      "you cannot read its repositories",
      "the evidence could not be verified",
      "it was not checked",
    ]);
  });

  it("lists a product in scope with no row yet as not checked, saying why", () => {
    const running = view({ status: "running", productIds: ["p"], productNames: { p: "Billing" } });
    expect(coverageRows(running)).toEqual([
      expect.objectContaining({
        productId: "p",
        name: "Billing",
        coverage: "not-checked",
        reason: "the check has not reached it yet",
      }),
    ]);
    const failed = view({ status: "failed", productIds: ["p"] });
    expect(coverageRows(failed)[0].reason).toBe("the assessment failed before it was checked");
  });

  it("leaves out a product the impact walk reached outside the scope", () => {
    const v = view({
      productIds: ["in"],
      products: [
        product("in", "not-covered"),
        product("down", "not-checked", {}, { impactKind: "downstream-consumer" }),
      ],
    });
    expect(coverageRows(v).map((r) => r.productId)).toEqual(["in"]);
  });

  it("names the covering repos: implemented ones, or ones meeting a criterion", () => {
    const rows = coverageRows(fiveStates());
    expect(rows[0].coveringRepos).toEqual(["acme/payments"]);
    expect(rows[1].coveringRepos).toEqual(["acme/ledger"]);
    expect(rows[2].coveringRepos).toEqual([]);
  });
});

describe("storedRepos", () => {
  it("reads only well-formed repo entries", () => {
    expect(storedRepos({ technicalDetail: {} })).toEqual([]);
    expect(
      storedRepos({
        technicalDetail: {
          repos: [
            null,
            { repoConnectionId: 1, label: "x" },
            { repoConnectionId: "r", label: "acme/r", verdict: 3, criteria: ["implemented", 2] },
          ],
        },
      }),
    ).toEqual([{ repoConnectionId: "r", label: "acme/r", verdict: "", criteria: ["implemented"] }]);
  });
});

describe("coverageHeadline", () => {
  it("names the covering product and its repo", () => {
    expect(coverageHeadline(fiveStates())).toEqual({
      tone: "covered",
      text: "Covered by Billing (acme/payments)",
    });
  });

  it("says partly covered, naming the partial products", () => {
    const v = fiveStates();
    v.verdict = "partial";
    expect(coverageHeadline(v)).toEqual({
      tone: "partial",
      text: "Partly covered by Ledger (acme/ledger)",
    });
  });

  it("says plainly that nothing covers it", () => {
    const v = view({
      verdict: "gap-confirmed",
      productIds: ["p"],
      products: [product("p", "not-covered")],
    });
    expect(coverageHeadline(v)).toEqual({
      tone: "gap",
      text: "Nothing in your portfolio covers this",
    });
  });

  it("names the products with no repositories under a confirmed gap (#1677)", () => {
    const v = view({
      verdict: "gap-confirmed",
      productIds: ["p", "e1", "e2", "r"],
      productNames: { p: "Payments", e1: "Empty", e2: "Spare", r: "Restricted repos" },
      products: [
        product("p", "not-covered"),
        product("e1", "not-checked", repoDetail([], "no-repos")),
        product("e2", "not-checked", repoDetail([], "no-repos")),
        product("r", "not-checked", repoDetail([], "repos-restricted")),
      ],
    });
    expect(coverageHeadline(v)).toEqual({
      tone: "gap",
      text: "Nothing in your portfolio covers this",
      note: "Empty, Spare have no repositories, so there was nothing in them to check.",
    });
    v.productIds = ["p", "e1"];
    v.products = v.products.slice(0, 2);
    expect(coverageHeadline(v)?.note).toBe(
      "Empty has no repositories, so there was nothing in it to check.",
    );
  });

  it("#1685 — names the first three products with no repositories, then how many more", () => {
    const ids = ["e1", "e2", "e3", "e4", "e5"];
    const v = view({
      verdict: "gap-confirmed",
      productIds: ["p", ...ids],
      productNames: { p: "Payments", e1: "A", e2: "B", e3: "C", e4: "D", e5: "E" },
      products: [
        product("p", "not-covered"),
        ...ids.map((id) => product(id, "not-checked", repoDetail([], "no-repos"))),
      ],
    });
    expect(coverageHeadline(v)?.note).toBe(
      "A, B, C and 2 more have no repositories, so there was nothing in them to check.",
    );
    v.products = v.products.slice(0, 4);
    expect(coverageHeadline(v)?.note).toBe(
      "A, B, C have no repositories, so there was nothing in them to check.",
    );
  });

  it("does not claim a gap it could not verify", () => {
    expect(coverageHeadline(view({ verdict: "could-not-verify" }))?.tone).toBe("unknown");
  });

  it("names a covering product with no name or repo plainly", () => {
    const v = view({
      verdict: "implemented",
      productIds: ["p"],
      products: [product("p", "covers")],
    });
    expect(coverageHeadline(v)?.text).toBe("Covered by a product");
  });

  it("has no answer while the run is pending or running", () => {
    expect(coverageHeadline(view({ status: "running", verdict: null }))).toBeNull();
    expect(coverageHeadline(view({ status: "pending", verdict: "implemented" }))).toBeNull();
    expect(coverageHeadline(view({ status: "completed", verdict: null }))).toBeNull();
  });

  it("says a failed run failed", () => {
    expect(coverageHeadline(view({ status: "failed" }))).toEqual({
      tone: "unknown",
      text: "This check failed before it reached an answer",
    });
  });
});
