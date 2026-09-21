/**
 * Unit tests for the semantic contract diff engine (Issue #90 / Epic #86).
 *
 * These cover:
 *  - extractContractItems() normalises OpenAPI / GraphQL / protobuf specs into a
 *    flat, order-independent set of comparable items;
 *  - hashContractItems() produces a stable content hash used for dedupe;
 *  - diffContracts() computes added / removed / changed items across all three
 *    contract types;
 *  - renderContractDiff() surfaces the diff as a Markdown section;
 *  - the "initial version" (no previous) path yields no diff.
 */
import { describe, expect, it } from "vitest";
import type { CrawlSpec } from "./repo-crawler.js";
import {
  extractContractItems,
  hashContractItems,
  diffContracts,
  renderContractDiff,
  summarizeDiff,
  type ContractItem,
} from "./contract-diff.js";

function openapi(paths: Record<string, unknown>): CrawlSpec {
  return {
    format: "openapi",
    filePath: "openapi.json",
    content: JSON.stringify({ openapi: "3.0.0", paths }),
  };
}

describe("extractContractItems", () => {
  it("extracts OpenAPI endpoints as method+path items", () => {
    const items = extractContractItems([
      openapi({
        "/users": {
          get: { summary: "List users" },
          post: { summary: "Create user" },
        },
      }),
    ]);
    const ids = items.map((i) => i.id).sort();
    expect(ids).toEqual(["openapi endpoint GET /users", "openapi endpoint POST /users"]);
    expect(items.every((i) => i.kind === "endpoint")).toBe(true);
  });

  it("extracts GraphQL types and their fields into a signature", () => {
    const items = extractContractItems([
      { format: "graphql", filePath: "s.graphql", content: "type User { id: ID name: String }" },
    ]);
    const user = items.find((i) => i.id === "graphql type User");
    expect(user).toBeDefined();
    expect(user?.signature).toContain("id");
    expect(user?.signature).toContain("name");
  });

  it("extracts protobuf services (rpc methods) and messages (fields)", () => {
    const items = extractContractItems([
      {
        format: "protobuf",
        filePath: "s.proto",
        content:
          "service Greeter { rpc SayHello (Req) returns (Res); }\nmessage Req { string name = 1; }",
      },
    ]);
    const ids = items.map((i) => i.id).sort();
    expect(ids).toContain("protobuf service Greeter");
    expect(ids).toContain("protobuf message Req");
  });

  it("is order-independent (sorted)", () => {
    const a = extractContractItems([openapi({ "/b": { get: {} }, "/a": { get: {} } })]);
    const b = extractContractItems([openapi({ "/a": { get: {} }, "/b": { get: {} } })]);
    expect(a.map((i) => i.id)).toEqual(b.map((i) => i.id));
  });

  it("returns an empty array when there are no specs", () => {
    expect(extractContractItems([])).toEqual([]);
  });
});

describe("hashContractItems", () => {
  it("is stable for identical content", () => {
    const items: ContractItem[] = extractContractItems([
      openapi({ "/x": { get: { summary: "s" } } }),
    ]);
    expect(hashContractItems(items)).toEqual(hashContractItems([...items]));
  });

  it("changes when a signature changes", () => {
    const before = extractContractItems([openapi({ "/x": { get: { summary: "one" } } })]);
    const after = extractContractItems([openapi({ "/x": { get: { summary: "two" } } })]);
    expect(hashContractItems(before)).not.toEqual(hashContractItems(after));
  });

  it("is independent of spec ordering", () => {
    const a = extractContractItems([openapi({ "/b": { get: {} }, "/a": { get: {} } })]);
    const b = extractContractItems([openapi({ "/a": { get: {} }, "/b": { get: {} } })]);
    expect(hashContractItems(a)).toEqual(hashContractItems(b));
  });
});

describe("diffContracts", () => {
  it("returns all-empty diff with hasChanges=false for identical contracts", () => {
    const items = extractContractItems([openapi({ "/x": { get: { summary: "s" } } })]);
    const diff = diffContracts(items, [...items]);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([]);
    expect(diff.hasChanges).toBe(false);
  });

  it("flags added endpoints", () => {
    const prev = extractContractItems([openapi({ "/x": { get: {} } })]);
    const next = extractContractItems([openapi({ "/x": { get: {} }, "/y": { post: {} } })]);
    const diff = diffContracts(prev, next);
    expect(diff.added.map((i) => i.id)).toEqual(["openapi endpoint POST /y"]);
    expect(diff.removed).toEqual([]);
    expect(diff.hasChanges).toBe(true);
  });

  it("flags removed endpoints", () => {
    const prev = extractContractItems([openapi({ "/x": { get: {} }, "/y": { post: {} } })]);
    const next = extractContractItems([openapi({ "/x": { get: {} } })]);
    const diff = diffContracts(prev, next);
    expect(diff.removed.map((i) => i.id)).toEqual(["openapi endpoint POST /y"]);
    expect(diff.added).toEqual([]);
    expect(diff.hasChanges).toBe(true);
  });

  it("flags changed endpoints (same id, different signature)", () => {
    const prev = extractContractItems([openapi({ "/x": { get: { summary: "old" } } })]);
    const next = extractContractItems([openapi({ "/x": { get: { summary: "new" } } })]);
    const diff = diffContracts(prev, next);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0].id).toBe("openapi endpoint GET /x");
    expect(diff.changed[0].before).toContain("old");
    expect(diff.changed[0].after).toContain("new");
    expect(diff.hasChanges).toBe(true);
  });

  it("detects added/removed GraphQL types", () => {
    const prev = extractContractItems([
      { format: "graphql", filePath: "s.graphql", content: "type A { id: ID }" },
    ]);
    const next = extractContractItems([
      { format: "graphql", filePath: "s.graphql", content: "type B { id: ID }" },
    ]);
    const diff = diffContracts(prev, next);
    expect(diff.added.map((i) => i.id)).toEqual(["graphql type B"]);
    expect(diff.removed.map((i) => i.id)).toEqual(["graphql type A"]);
  });

  it("detects changed protobuf messages", () => {
    const prev = extractContractItems([
      { format: "protobuf", filePath: "s.proto", content: "message M { string a = 1; }" },
    ]);
    const next = extractContractItems([
      {
        format: "protobuf",
        filePath: "s.proto",
        content: "message M { string a = 1; int32 b = 2; }",
      },
    ]);
    const diff = diffContracts(prev, next);
    expect(diff.changed.map((i) => i.id)).toEqual(["protobuf message M"]);
  });

  it("treats an empty previous as all-added (first real content)", () => {
    const next = extractContractItems([openapi({ "/x": { get: {} } })]);
    const diff = diffContracts([], next);
    expect(diff.added.map((i) => i.id)).toEqual(["openapi endpoint GET /x"]);
    expect(diff.hasChanges).toBe(true);
  });
});

describe("summarizeDiff", () => {
  it("produces a compact human summary", () => {
    const prev = extractContractItems([
      openapi({ "/x": { get: {} }, "/z": { get: { summary: "a" } } }),
    ]);
    const next = extractContractItems([
      openapi({ "/y": { post: {} }, "/z": { get: { summary: "b" } } }),
    ]);
    const diff = diffContracts(prev, next);
    const summary = summarizeDiff(diff);
    expect(summary).toContain("1 added");
    expect(summary).toContain("1 removed");
    expect(summary).toContain("1 changed");
  });

  it("says 'No contract changes' when nothing changed", () => {
    const items = extractContractItems([openapi({ "/x": { get: {} } })]);
    expect(summarizeDiff(diffContracts(items, [...items]))).toMatch(/no contract changes/i);
  });
});

describe("renderContractDiff", () => {
  it("renders an 'initial version' notice when there is no previous version", () => {
    const md = renderContractDiff(null);
    expect(md).toMatch(/initial version/i);
    expect(md).toContain("## Changes Since Previous Version");
  });

  it("renders added/removed/changed subsections", () => {
    const prev = extractContractItems([
      openapi({ "/gone": { get: {} }, "/mod": { get: { summary: "a" } } }),
    ]);
    const next = extractContractItems([
      openapi({ "/new": { post: {} }, "/mod": { get: { summary: "b" } } }),
    ]);
    const diff = diffContracts(prev, next);
    const md = renderContractDiff(diff);
    expect(md).toContain("### Added");
    expect(md).toContain("POST /new");
    expect(md).toContain("### Removed");
    expect(md).toContain("GET /gone");
    expect(md).toContain("### Changed");
    expect(md).toContain("GET /mod");
  });

  it("renders a no-changes line when the diff is empty", () => {
    const items = extractContractItems([openapi({ "/x": { get: {} } })]);
    const md = renderContractDiff(diffContracts(items, [...items]));
    expect(md).toMatch(/no contract changes/i);
  });
});
