/**
 * Default clarifying-questions toggle (current branch).
 *
 * The analysis page enables clarifying questions by default so the
 * doc-grounded questions surface without the user opting in (the toggle still
 * lets them opt out). The page itself is coverage-excluded and impractical to
 * render in jsdom (socket/router deps), so we assert the default-ON intent at
 * the source-contract level: the `enableClarification` state must initialize to
 * `true`.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// vitest runs from the `ui/` package root.
const pagePath = path.resolve(process.cwd(), "src/app/(authed)/projects/[id]/analysis/page.tsx");

describe("analysis page — clarification default", () => {
  it("defaults enableClarification to true (questions surface by default)", () => {
    const source = readFileSync(pagePath, "utf8");
    expect(source).toMatch(
      /useState\(true\);\s*\n.*enableClarification|enableClarification.*useState\(true\)/s,
    );
    // Tight assertion on the exact declaration regardless of formatting.
    const normalized = source.replace(/\s+/g, " ");
    expect(normalized).toContain(
      "const [enableClarification, setEnableClarification] = useState(true);",
    );
  });

  it("keeps the opt-out toggle wired (setEnableClarification used)", () => {
    const source = readFileSync(pagePath, "utf8");
    expect(source).toContain("setEnableClarification");
  });
});
