/**
 * Issue #1228 — the Schema Graph tab strip must stay reachable on a `degraded`
 * database document.
 *
 * `canShowSchemaGraphTabs` is unit-tested in `doc-warnings-resolution.test.ts`,
 * but a pure predicate proves nothing on its own: the defect this fixes lived at
 * the JSX call site, and restoring the inline `status === "ready"` gate there
 * would leave every predicate test green.
 *
 * The documentation page is a Next.js client page with react-query, sockets and
 * a Mermaid renderer, and has no component test to hang this on. So this asserts
 * on the source: the tab strip is gated by the predicate, and the literal form
 * the fix removed is gone. It is deliberately narrow — the two strings below are
 * exactly what a revert would reintroduce — and it fails loudly rather than
 * silently if the page is restructured, which is the correct trade for a gate
 * with no other coverage.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const REL = path.join("src", "app", "(authed)", "projects", "[id]", "documentation", "page.tsx");
// `import.meta.url` is not a file URL under this package's vitest transform, so
// resolve from the working directory, tolerating both the package root and the
// repo root as the launch point.
const PAGE = [path.resolve(process.cwd(), REL), path.resolve(process.cwd(), "ui", REL)].find(
  (candidate) => existsSync(candidate),
);

if (!PAGE) throw new Error(`documentation page not found from ${process.cwd()}`);
const source = readFileSync(PAGE, "utf8");

describe("schema-graph tab wiring (#1228)", () => {
  it("gates the tab strip on the predicate, not on an inline status check", () => {
    expect(source).toContain("canShowSchemaGraphTabs(isDatabaseDoc, docDetail.data.status)");
  });

  it("has no document-status equality gate left in the page", () => {
    // `docDetail.data.status === "ready"` was the gate that hid the Schema Graph
    // explorer for exactly the documents #1228 marks degraded.
    expect(source).not.toContain('docDetail.data.status === "ready"');
  });
});
