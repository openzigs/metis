/**
 * JUnit XML parser tests — Epic #260 / issue #45.
 *
 * Validates:
 *   - parsing nested <testsuites>/<testsuite>/<testcase> with failure/error/skipped
 *   - status derivation (passed / failed / error->failed / skipped)
 *   - single-suite (no <testsuites> root) handling
 *   - SECURITY: XXE payloads do not read the filesystem; billion-laughs
 *     payloads do not expand; oversized input and DOCTYPE are rejected.
 */
import { describe, expect, it } from "vitest";

import {
  parseJUnitXml,
  JUNIT_MAX_BYTES,
  JunitParseError,
} from "../../../src/lib/testcoverage/junit-parser.js";

const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="auth" tests="4">
    <testcase classname="auth.LoginTest" name="logs in with valid creds" time="0.5"/>
    <testcase classname="auth.LoginTest" name="rejects bad password" time="0.4">
      <failure message="expected 401">AssertionError: ...</failure>
    </testcase>
    <testcase classname="auth.LoginTest" name="handles server error" time="0.1">
      <error message="boom">RuntimeError</error>
    </testcase>
    <testcase classname="auth.LoginTest" name="sso flow" time="0">
      <skipped/>
    </testcase>
  </testsuite>
</testsuites>`;

describe("parseJUnitXml", () => {
  it("parses nested testsuites and derives status per testcase", () => {
    const result = parseJUnitXml(SAMPLE);
    expect(result).toHaveLength(4);
    const byName = new Map(result.map((r) => [r.name, r]));
    expect(byName.get("logs in with valid creds")?.status).toBe("passed");
    expect(byName.get("rejects bad password")?.status).toBe("failed");
    expect(byName.get("rejects bad password")?.message).toContain("expected 401");
    expect(byName.get("handles server error")?.status).toBe("failed");
    expect(byName.get("sso flow")?.status).toBe("skipped");
    expect(byName.get("logs in with valid creds")?.classname).toBe("auth.LoginTest");
  });

  it("parses a single <testsuite> root (no <testsuites> wrapper)", () => {
    const xml = `<testsuite name="s"><testcase name="only one"/></testsuite>`;
    const result = parseJUnitXml(xml);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("only one");
    expect(result[0].status).toBe("passed");
  });

  it("returns an empty list for a suite with no testcases", () => {
    expect(parseJUnitXml(`<testsuites></testsuites>`)).toEqual([]);
  });

  it("throws JunitParseError on non-XML / malformed input", () => {
    expect(() => parseJUnitXml("not xml at all <<<")).toThrow(JunitParseError);
  });

  it("throws JunitParseError on empty input", () => {
    expect(() => parseJUnitXml("")).toThrow(JunitParseError);
  });

  it("falls back to the failure element body when there is no message attribute", () => {
    const xml = `<testsuite><testcase name="t">
      <failure>AssertionError: boom happened</failure></testcase></testsuite>`;
    const [r] = parseJUnitXml(xml);
    expect(r.status).toBe("failed");
    expect(r.message).toContain("AssertionError: boom happened");
  });

  it("uses the error element body text when present", () => {
    const xml = `<testsuite><testcase name="t">
      <error>stack trace line</error></testcase></testsuite>`;
    const [r] = parseJUnitXml(xml);
    expect(r.status).toBe("failed");
    expect(r.message).toContain("stack trace line");
  });

  it("SECURITY: rejects input larger than the byte cap", () => {
    const big = `<testsuites>${"<!-- pad -->".repeat(JUNIT_MAX_BYTES)}</testsuites>`;
    expect(() => parseJUnitXml(big)).toThrow(JunitParseError);
  });

  it("SECURITY: rejects a DOCTYPE declaration (XXE / entity surface)", () => {
    const xxe = `<?xml version="1.0"?>
      <!DOCTYPE foo [ <!ENTITY xxe SYSTEM "file:///etc/passwd"> ]>
      <testsuites><testsuite><testcase name="&xxe;"/></testsuite></testsuites>`;
    expect(() => parseJUnitXml(xxe)).toThrow(JunitParseError);
  });

  it("SECURITY: an XXE external entity is never resolved to file contents", () => {
    // Even if the DOCTYPE guard were bypassed, entity processing is disabled,
    // so a referenced entity must NOT expand into /etc/passwd contents.
    const xxe = `<testsuites><testsuite><testcase name="&xxe; literal"/></testsuite></testsuites>`;
    const result = parseJUnitXml(xxe);
    const joined = JSON.stringify(result);
    expect(joined).not.toContain("root:");
    expect(joined).not.toContain("/bin/bash");
  });

  it("SECURITY: a billion-laughs payload does not expand", () => {
    const lol = `<?xml version="1.0"?>
      <!DOCTYPE lolz [
        <!ENTITY lol "lol">
        <!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">
        <!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">
      ]>
      <testsuites><testsuite><testcase name="&lol3;"/></testsuite></testsuites>`;
    // DOCTYPE present -> rejected before any expansion can occur.
    expect(() => parseJUnitXml(lol)).toThrow(JunitParseError);
  });

  it("SECURITY: caps the number of testcases", () => {
    const cases = Array.from({ length: 60000 }, (_, i) => `<testcase name="t${i}"/>`).join("");
    const xml = `<testsuites><testsuite>${cases}</testsuite></testsuites>`;
    expect(() => parseJUnitXml(xml)).toThrow(JunitParseError);
  });
});
