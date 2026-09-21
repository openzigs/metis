/**
 * #1091 — pin the GitHub REST issue shape against a RECORDED response.
 *
 * ## Why this file exists
 *
 * The publish pipeline shipped `interface GhIssue { id: string /* node id *\/ }`
 * while the REST API returns a **numeric** `id` and a separate string
 * `node_id`. Every response is cast (`client.request<GhIssue>`), so nothing
 * checked the claim, and the whole test suite was green because the mocked
 * Octokit declared the same invented shape. The bug only surfaced against the
 * real API — after 8 issues had been created on a live repo, all of which
 * METIS then recorded as failed.
 *
 * A mocked test cannot catch a type mismatch: the mock declares whatever the
 * author writes. So the shape is pinned two ways that do not depend on anyone
 * writing it correctly:
 *
 *  1. **A recorded response.** `fixtures/github-rest-issue.json` was captured
 *     from the live API with:
 *
 *         gh api repos/octocat/Hello-World/issues/349 > github-rest-issue.json
 *
 *     (public repo, no credentials embedded, captured 2026-07-27). The
 *     assertions below read the field *types* off that recording, so they
 *     describe GitHub's contract rather than our belief about it.
 *
 *  2. **A compile-time conformance check against Octokit's own generated
 *     OpenAPI types**, which lives in `src/lib/publishing/types.ts` — not
 *     here. `server/tsconfig.json` excludes `tests/`, so a type-level
 *     assertion parked in a test file would never be evaluated by
 *     `pnpm typecheck`. Re-declaring `id: string` fails the build there.
 *
 * Honest limitation: neither mechanism exercises a real network call. What
 * they guarantee is that our declared shape matches Octokit's published schema
 * and a genuinely recorded payload. A GitHub-side breaking change to the live
 * API would still need the runtime guard (`readIssueIdentity`) to surface it,
 * which is what the last describe block covers.
 */
import { describe, expect, it } from "vitest";
import { readIssueIdentity } from "../src/lib/publishing/types.js";
import fixture from "./fixtures/github-rest-issue.json" with { type: "json" };

describe("#1091 — recorded GitHub REST issue payload", () => {
  it("has a NUMERIC id and a SEPARATE string node_id", () => {
    // The exact confusion that broke the pipeline. `id` is the numeric
    // database id; `node_id` is the GraphQL global id. They are different
    // values of different types and are not interchangeable.
    expect(typeof fixture.id).toBe("number");
    expect(typeof fixture.node_id).toBe("string");
    expect(String(fixture.id)).not.toBe(fixture.node_id);
  });

  it("has a numeric per-repo number distinct from the database id", () => {
    expect(typeof fixture.number).toBe("number");
    expect(fixture.number).not.toBe(fixture.id);
  });

  it("carries the html_url the publisher persists", () => {
    expect(typeof fixture.html_url).toBe("string");
    expect(fixture.html_url).toMatch(/^https:\/\//);
  });
});

describe("readIssueIdentity", () => {
  it("splits a real payload into node id (persisted) and REST id (sub-issue API)", () => {
    const identity = readIssueIdentity(fixture);
    expect(identity.nodeId).toBe(fixture.node_id);
    expect(identity.restId).toBe(fixture.id);
    expect(identity.number).toBe(fixture.number);
    expect(identity.htmlUrl).toBe(fixture.html_url);
    // What `PublishedIssue.issueId` (a String column) receives.
    expect(typeof identity.nodeId).toBe("string");
    // What `sub_issue_id` receives.
    expect(typeof identity.restId).toBe("number");
  });

  it("rejects the pre-fix stub shape instead of silently passing it through", () => {
    // Exactly what the old hand-written mock returned: a string `id`, no
    // `node_id`. Under the old code this flowed straight into Prisma.
    expect(() =>
      readIssueIdentity({
        id: "node_101",
        number: 101,
        html_url: "https://github.com/acme/metis/issues/101",
      }),
    ).toThrowError(/node_id/);
  });

  it("rejects a payload whose node_id is present but numeric", () => {
    expect(() => readIssueIdentity({ ...fixture, node_id: 12345 })).toThrowError(/node_id/);
  });

  it("rejects a payload whose id is a numeric string", () => {
    // A proxy or JSON re-serialiser that stringifies numbers must not be
    // allowed to feed a string into `sub_issue_id`.
    expect(() => readIssueIdentity({ ...fixture, id: "231391551" })).toThrowError(/numeric `id`/);
  });

  it("rejects null / non-object payloads", () => {
    expect(() => readIssueIdentity(null)).toThrowError(/node_id/);
    expect(() => readIssueIdentity(undefined)).toThrowError(/node_id/);
    expect(() => readIssueIdentity("not an issue")).toThrowError(/node_id/);
  });

  it("rejects a payload missing the issue number", () => {
    const { number: _dropped, ...noNumber } = fixture;
    expect(() => readIssueIdentity(noNumber)).toThrowError(/`number`/);
  });

  it("carries a 502 GH_ISSUE_SHAPE_INVALID rather than a bare Error", () => {
    try {
      readIssueIdentity({});
      throw new Error("expected readIssueIdentity to throw");
    } catch (err) {
      expect((err as { code?: string }).code).toBe("GH_ISSUE_SHAPE_INVALID");
      expect((err as { status?: number }).status).toBe(502);
    }
  });

  it("tolerates a missing html_url without failing the publish", () => {
    // Not identity-critical: the row can carry an empty url, whereas a wrong
    // identifier corrupts dedup and sub-issue linking.
    const { html_url: _dropped, ...noUrl } = fixture;
    expect(readIssueIdentity(noUrl).htmlUrl).toBe("");
  });
});
