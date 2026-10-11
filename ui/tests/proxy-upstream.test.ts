// @vitest-environment node
/**
 * #1069 — the two path rules of the `/api/*` proxy, each on its own: which
 * decoded segment is refused, and which resolved URL is still under the base.
 */
import { describe, expect, it } from "vitest";
import {
  isDotSegment,
  isUnsafeProxySegment,
  pathBelowUpstreamBase,
  upstreamBasePath,
} from "@/lib/proxy-upstream";

const BASE = "http://localhost:4000/api";
/** What the route builds: the base, a slash, the segments joined. */
const resolve = (...segments: string[]): URL => new URL(`${BASE}/${segments.join("/")}`);

describe("isUnsafeProxySegment", () => {
  it.each([
    "../../../../chat/stream",
    "x/../../constitution",
    "..\\..\\constitution",
    "x?y=1",
    "x#y",
    "a/b",
    "a\\b",
    ".",
    "..",
    "%2e",
    "%2E%2e",
    ".%2e",
    "%2e.",
    ".\t.",
    "a\nb",
    "a\rb",
    "a\u0000b",
    "a\u007fb",
  ])("refuses %j", (segment) => {
    expect(isUnsafeProxySegment(segment)).toBe(true);
  });

  it.each([
    "p1",
    "speckit.plan",
    "my doc.md",
    "..hidden",
    "a..b",
    "...",
    "a%2Fb",
    "50%",
    "%2e%2e%2e",
    "a:b@c+d,e;f=g&h",
    "naïve-ü",
    "",
  ])("accepts %j", (segment) => {
    expect(isUnsafeProxySegment(segment)).toBe(false);
  });
});

describe("isDotSegment", () => {
  it("is true only for the spellings `new URL` resolves away", () => {
    for (const s of [".", "..", "%2e", "%2E", "%2e%2e", ".%2E", "%2e."]) {
      expect(isDotSegment(s)).toBe(true);
    }
    for (const s of ["", "...", "a.", ".a", "%2e%2e%2e", "p1"]) expect(isDotSegment(s)).toBe(false);
  });
});

describe("upstreamBasePath", () => {
  it("is the base's path without a trailing slash", () => {
    expect(upstreamBasePath(BASE)).toBe("/api");
    expect(upstreamBasePath("http://server:4000/api/")).toBe("/api");
    expect(upstreamBasePath("http://server:4000/metis/api")).toBe("/metis/api");
    expect(upstreamBasePath("http://server:4000")).toBe("");
  });
});

// These hand the resolver the hostile segments the route would refuse first,
// so the second rule is shown to hold without the first.
describe("pathBelowUpstreamBase", () => {
  it("returns the resolved path below the base", () => {
    expect(pathBelowUpstreamBase(resolve("projects", "p1", "files"), BASE)).toBe(
      "projects/p1/files",
    );
    expect(pathBelowUpstreamBase(resolve("projects", "my doc.md"), BASE)).toBe(
      "projects/my%20doc.md",
    );
    expect(pathBelowUpstreamBase(resolve(), BASE)).toBe("");
  });

  it("returns the route the URL really names, not the one the segments spell", () => {
    const commands = ["projects", "p1", "spec-kit", "commands"];
    expect(pathBelowUpstreamBase(resolve(...commands, "../../../../chat/stream"), BASE)).toBe(
      "chat/stream",
    );
    expect(pathBelowUpstreamBase(resolve(...commands, "x/../../constitution"), BASE)).toBe(
      "projects/p1/spec-kit/constitution",
    );
    expect(pathBelowUpstreamBase(resolve(...commands, "..\\..\\constitution"), BASE)).toBe(
      "projects/p1/constitution",
    );
    expect(pathBelowUpstreamBase(resolve(...commands, "x?y=1"), BASE)).toBe(
      "projects/p1/spec-kit/commands/x",
    );
  });

  it.each([
    [
      "out of /api to /health",
      [..."projects/p1/spec-kit/commands".split("/"), "../../../../../health"],
    ],
    ["from the project id", ["projects", "../../a", "spec-kit", "commands", "x"]],
    ["to the root", ["..", ".."]],
    ["to a lookalike prefix", ["..", "apiary", "x"]],
    ["behind a tab", [".\t.", "health"]],
    ["as an encoded dot segment", ["%2e%2e", "health"]],
  ])("is null for a path that walks %s", (_name, segments) => {
    expect(pathBelowUpstreamBase(resolve(...segments), BASE)).toBeNull();
  });

  it("is null for the base itself without a trailing slash, and for another origin", () => {
    expect(pathBelowUpstreamBase(new URL("http://localhost:4000/api"), BASE)).toBeNull();
    expect(pathBelowUpstreamBase(new URL("http://evil.test/api/projects"), BASE)).toBeNull();
    expect(pathBelowUpstreamBase(new URL("http://localhost:4001/api/projects"), BASE)).toBeNull();
  });

  it("honours a base that is not /api", () => {
    const base = "http://server:4000/metis/api/";
    expect(pathBelowUpstreamBase(new URL("http://server:4000/metis/api/chat"), base)).toBe("chat");
    expect(pathBelowUpstreamBase(new URL("http://server:4000/api/chat"), base)).toBeNull();
  });
});
