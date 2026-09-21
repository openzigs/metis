/**
 * JUnit XML parser (Epic #260, issue #45).
 *
 * Parses a JUnit results document — `<testsuites>/<testsuite>/<testcase>` with
 * optional `<failure>`, `<error>` and `<skipped>` children — into a flat,
 * normalised list of {@link JunitTestResult}.
 *
 * SECURITY: JUnit XML is untrusted input (a CI artefact uploaded by a user).
 * We harden the parse against the classic XML attacks:
 *   - **XXE / external entities**: `fast-xml-parser` is configured with
 *     `processEntities: false`, so NO entity (built-in, internal, or external)
 *     is ever expanded — a `&xxe;` reference is left inert. fast-xml-parser
 *     does not implement DTD/external-entity resolution, so there is no
 *     file/network read surface even without the flag; the flag makes the
 *     guarantee explicit and also defeats internal-entity expansion DoS.
 *   - **billion-laughs / entity-expansion DoS**: rejected up-front — any input
 *     containing a `<!DOCTYPE` declaration is refused before parsing, so no
 *     `<!ENTITY>` definitions can be processed.
 *   - **resource exhaustion**: input is byte-capped ({@link JUNIT_MAX_BYTES})
 *     and the number of testcases is capped ({@link JUNIT_MAX_CASES}).
 *
 * fast-xml-parser confirmed safe (OSV: 0 known vulns for 5.9.2; the
 * 2026 regex-injection/DOCTYPE advisories are fixed in >= 5.3.5). We never
 * pass user input to a regex constructor.
 */
import { XMLParser } from "fast-xml-parser";

/** Max accepted input size (10 MB). */
export const JUNIT_MAX_BYTES = 10 * 1024 * 1024;

/** Max accepted testcase count (defends against pathological documents). */
export const JUNIT_MAX_CASES = 50_000;

export type JunitStatus = "passed" | "failed" | "skipped";

export interface JunitTestResult {
  readonly name: string;
  readonly classname?: string;
  readonly status: JunitStatus;
  readonly message?: string;
  /** Suite name the testcase belongs to, when present. */
  readonly suite?: string;
}

export class JunitParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JunitParseError";
  }
}

const ATTR_PREFIX = "@_";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: ATTR_PREFIX,
  // Disable ALL entity processing — defeats XXE and internal-entity DoS.
  processEntities: false,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  // Force the elements we iterate to always be arrays so we never special-case
  // the single-child shape.
  isArray: (name) => name === "testsuites" || name === "testsuite" || name === "testcase",
});

type XmlNode = Record<string, unknown>;

/**
 * Parse a JUnit XML string into normalised results. Throws {@link JunitParseError}
 * for oversized input, DOCTYPE-bearing input, malformed XML, or too many cases.
 */
export function parseJUnitXml(xml: string): JunitTestResult[] {
  if (typeof xml !== "string" || xml.length === 0) {
    throw new JunitParseError("Empty JUnit XML input");
  }
  // Byte-length cap (handles multi-byte chars correctly).
  if (Buffer.byteLength(xml, "utf8") > JUNIT_MAX_BYTES) {
    throw new JunitParseError(`JUnit XML exceeds the ${JUNIT_MAX_BYTES}-byte limit`);
  }
  // Reject any DOCTYPE outright — there is no legitimate reason for a JUnit
  // results file to declare a DTD, and it is the only vector for <!ENTITY>.
  if (/<!DOCTYPE/i.test(xml) || /<!ENTITY/i.test(xml)) {
    throw new JunitParseError("DOCTYPE / ENTITY declarations are not allowed in JUnit XML");
  }

  let doc: XmlNode;
  try {
    doc = parser.parse(xml) as XmlNode;
  } catch (err) {
    throw new JunitParseError(`Failed to parse JUnit XML: ${(err as Error).message}`);
  }
  if (!doc || typeof doc !== "object") {
    throw new JunitParseError("JUnit XML did not parse to an object");
  }

  const suites = collectSuites(doc);
  const results: JunitTestResult[] = [];
  for (const suite of suites) {
    const suiteName = attr(suite, "name");
    const cases = asArray(suite.testcase);
    for (const tc of cases) {
      if (!isNode(tc)) continue;
      const name = attr(tc, "name");
      if (!name) continue;
      results.push({
        name,
        classname: attr(tc, "classname") || undefined,
        status: deriveStatus(tc),
        message: extractMessage(tc),
        suite: suiteName || undefined,
      });
      if (results.length > JUNIT_MAX_CASES) {
        throw new JunitParseError(`JUnit XML exceeds the ${JUNIT_MAX_CASES}-testcase limit`);
      }
    }
  }
  return results;
}

// ---- helpers --------------------------------------------------------------

function collectSuites(doc: XmlNode): XmlNode[] {
  // Either <testsuites><testsuite>...</testsuite></testsuites> or a bare
  // <testsuite> root.
  const out: XmlNode[] = [];
  const suitesRoots = asArray(doc.testsuites);
  for (const root of suitesRoots) {
    if (isNode(root)) out.push(...asArray(root.testsuite).filter(isNode));
  }
  for (const bare of asArray(doc.testsuite)) {
    if (isNode(bare)) out.push(bare);
  }
  return out;
}

function deriveStatus(tc: XmlNode): JunitStatus {
  if (tc.skipped !== undefined) return "skipped";
  if (tc.failure !== undefined) return "failed";
  if (tc.error !== undefined) return "failed";
  return "passed";
}

function extractMessage(tc: XmlNode): string | undefined {
  for (const key of ["failure", "error", "skipped"] as const) {
    const node = tc[key];
    if (node === undefined) continue;
    const first = asArray(node)[0];
    if (isNode(first)) {
      const msg = attr(first, "message");
      if (msg) return msg;
      const text = first["#text"];
      if (typeof text === "string" && text.trim()) return text.trim();
    } else if (typeof first === "string" && first.trim()) {
      return first.trim();
    }
  }
  return undefined;
}

function attr(node: XmlNode, name: string): string {
  const v = node[`${ATTR_PREFIX}${name}`];
  return typeof v === "string" ? v : v === undefined || v === null ? "" : String(v);
}

function asArray(v: unknown): unknown[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function isNode(v: unknown): v is XmlNode {
  return typeof v === "object" && v !== null;
}
