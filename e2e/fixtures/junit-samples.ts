/**
 * Sample JUnit XML payloads for the round-trip upload suite (Epic #260, #45).
 *
 * The matcher in `server/src/lib/testcoverage/junit-roundtrip.ts` normalises
 * both the `<testcase name>` and the `TestCaseDoc.title` (lowercase, collapse
 * non-alphanumerics, strip any `class#method` prefix) before comparing, so the
 * names below are crafted to match seeded doc titles after normalisation.
 */

/**
 * Build a well-formed JUnit document. Each entry becomes one `<testcase>`;
 * `status` controls whether a `<failure>` / `<skipped>` child is emitted so the
 * parser derives the corresponding verdict.
 */
export function buildJunitXml(
  cases: ReadonlyArray<{ name: string; status: "passed" | "failed" | "skipped" }>,
  suiteName = "e2e-suite",
): string {
  const escape = (s: string): string =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const body = cases
    .map(({ name, status }) => {
      const attrs = `name="${escape(name)}" classname="${escape(suiteName)}"`;
      if (status === "failed") {
        return `    <testcase ${attrs}><failure message="assertion failed">expected true</failure></testcase>`;
      }
      if (status === "skipped") {
        return `    <testcase ${attrs}><skipped/></testcase>`;
      }
      return `    <testcase ${attrs}/>`;
    })
    .join("\n");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<testsuites>",
    `  <testsuite name="${escape(suiteName)}" tests="${cases.length}">`,
    body,
    "  </testsuite>",
    "</testsuites>",
    "",
  ].join("\n");
}

/**
 * A malformed JUnit document carrying a DOCTYPE + an external-entity (XXE)
 * definition that attempts to read `/etc/passwd`. The parser rejects ANY
 * DOCTYPE up-front, so this must yield `422 JUNIT_PARSE_FAILED` and the
 * response must NOT contain the file path or any expanded entity value.
 */
export const XXE_JUNIT_PAYLOAD = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  "<!DOCTYPE testsuites [",
  '  <!ENTITY xxe SYSTEM "file:///etc/passwd">',
  "]>",
  "<testsuites>",
  '  <testsuite name="evil" tests="1">',
  '    <testcase name="&xxe;" classname="evil"/>',
  "  </testsuite>",
  "</testsuites>",
  "",
].join("\n");

/** Syntactically broken XML (unclosed tag) — also a 422 parse failure. */
export const MALFORMED_JUNIT_XML = '<?xml version="1.0"?><testsuites><testsuite><testcase name="x"';
