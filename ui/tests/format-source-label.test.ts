import { describe, it, expect } from "vitest";
import { formatSourceLabel } from "@/lib/format-source-label";

describe("formatSourceLabel (#427)", () => {
  describe("well-formed connector:repo ids", () => {
    it("renders 'basename — repo' from a deeply-nested connector path", () => {
      const raw =
        "connector:repo:cmexample0000000000acmerp:src/components/wmsCommon/wms-common-db/src/main/java/com/acme/wms/common/mybatis/inv/vo/ShipmentAllocationsVO.java";
      const r = formatSourceLabel(raw);
      expect(r.isConnector).toBe(true);
      expect(r.basename).toBe("ShipmentAllocationsVO.java");
      // repoLabel is the connectorId short form (last 6 chars).
      expect(r.repoLabel).toBe("acmerp");
      expect(r.repoLabel).toBe("cmexample0000000000acmerp".slice(-6));
      expect(r.label).toBe("ShipmentAllocationsVO.java — acmerp");
      expect(r.path).toBe(
        "src/components/wmsCommon/wms-common-db/src/main/java/com/acme/wms/common/mybatis/inv/vo/ShipmentAllocationsVO.java",
      );
      // The noisy connector prefix must never leak into the human label.
      expect(r.label).not.toContain("connector:repo:");
      expect(r.basename).not.toContain("connector:repo:");
    });

    it("renders a bare-file connector id (no directory) as 'basename — repo'", () => {
      const r = formatSourceLabel("connector:repo:abc123def:README.md");
      expect(r.isConnector).toBe(true);
      expect(r.basename).toBe("README.md");
      expect(r.repoLabel).toBe("123def");
      expect(r.repoLabel).toBe("abc123def".slice(-6));
      expect(r.label).toBe("README.md — 123def");
      expect(r.path).toBe("README.md");
    });

    it("uses a short connectorId verbatim as the repo token when ≤ 6 chars", () => {
      const r = formatSourceLabel("connector:repo:abc:dir/sub/File.ts");
      expect(r.isConnector).toBe(true);
      expect(r.basename).toBe("File.ts");
      expect(r.repoLabel).toBe("abc");
      expect(r.label).toBe("File.ts — abc");
    });

    it("preserves a basename that contains dots and dashes", () => {
      const r = formatSourceLabel("connector:repo:xyz999000:a/b/c/my-file.spec.test.ts");
      expect(r.basename).toBe("my-file.spec.test.ts");
      expect(r.label).toBe("my-file.spec.test.ts — 999000");
    });

    it("drops the repo suffix when the connectorId is whitespace-only", () => {
      // `[^:]+` still matches a single space, but it trims to an empty token —
      // the label degrades to just the basename rather than 'file — '.
      const r = formatSourceLabel("connector:repo: :dir/File.ts");
      expect(r.isConnector).toBe(true);
      expect(r.basename).toBe("File.ts");
      expect(r.repoLabel).toBeUndefined();
      expect(r.label).toBe("File.ts");
    });
  });

  describe("repository names (#23)", () => {
    const names = { cmexample0000000000acmerp: "wms-core", abc123def: "metis" };

    it("shows the repository name instead of the connector-id tail", () => {
      const r = formatSourceLabel("connector:repo:abc123def:README.md", names);
      expect(r.repoLabel).toBe("metis");
      expect(r.label).toBe("README.md — metis");
      expect(r.label).not.toContain("123def");
      expect(r.rawId).toBe("connector:repo:abc123def:README.md");
    });

    it("resolves the name per connector", () => {
      const r = formatSourceLabel(
        "connector:repo:cmexample0000000000acmerp:src/main/java/Foo.java",
        names,
      );
      expect(r.label).toBe("Foo.java — wms-core");
    });

    it("falls back to the short token when the connector is not in the map", () => {
      expect(formatSourceLabel("connector:repo:zzz999888:README.md", names).label).toBe(
        "README.md — 999888",
      );
    });

    it("ignores a blank name and falls back to the short token", () => {
      expect(
        formatSourceLabel("connector:repo:abc123def:README.md", { abc123def: "  " }).label,
      ).toBe("README.md — 123def");
    });

    it("does not resolve inherited object keys as repository names", () => {
      expect(formatSourceLabel("connector:repo:constructor:README.md", {}).label).toBe(
        "README.md — ructor",
      );
    });
  });

  describe("live-schema ids (#732 — Sally's schema citations)", () => {
    it("renders a 'live-schema:<projectId>' id as a friendly 'Live schema' label", () => {
      const raw = "live-schema:proj-abc123";
      const r = formatSourceLabel(raw);
      expect(r.isConnector).toBe(false);
      expect(r.label).toBe("Live schema");
      expect(r.basename).toBe("Live schema");
      // The raw id is preserved for the tooltip — never a broken document link.
      expect(r.rawId).toBe(raw);
      expect(r.label).not.toContain("live-schema:");
    });

    it("matches the prefix even with an empty project suffix", () => {
      const r = formatSourceLabel("live-schema:");
      expect(r.isConnector).toBe(false);
      expect(r.label).toBe("Live schema");
      expect(r.rawId).toBe("live-schema:");
    });
  });

  describe("malformed / legacy id fallback (graceful degradation)", () => {
    it("returns a plain filename unchanged as the label", () => {
      const name = "D100 - UC101 Regional Hubs WMS_OMS Data Exchange_v0.8.docx";
      const r = formatSourceLabel(name);
      expect(r.isConnector).toBe(false);
      expect(r.label).toBe(name);
      expect(r.basename).toBe(name);
      expect(r.repoLabel).toBeUndefined();
      expect(r.path).toBeUndefined();
    });

    it("returns an empty string for empty input without crashing", () => {
      const r = formatSourceLabel("");
      expect(r.isConnector).toBe(false);
      expect(r.label).toBe("");
      expect(r.rawId).toBe("");
      expect(r.basename).toBe("");
    });

    it("returns an empty string for whitespace-only input", () => {
      const r = formatSourceLabel("   ");
      expect(r.isConnector).toBe(false);
      expect(r.label).toBe("");
      expect(r.rawId).toBe("");
    });

    it("does not match a connector id missing the path segment", () => {
      const raw = "connector:repo:onlyconnectorid";
      const r = formatSourceLabel(raw);
      expect(r.isConnector).toBe(false);
      expect(r.label).toBe(raw);
      expect(r.basename).toBe(raw);
    });

    it("does not match a connector id with the wrong prefix", () => {
      const raw = "connector:db:abc123:some/path.sql";
      const r = formatSourceLabel(raw);
      expect(r.isConnector).toBe(false);
      expect(r.label).toBe(raw);
    });

    it("does not match a bare 'connector:repo:' with no id or path", () => {
      const raw = "connector:repo:";
      const r = formatSourceLabel(raw);
      expect(r.isConnector).toBe(false);
      expect(r.label).toBe(raw);
    });

    it("falls back to the raw id when the path collapses to nothing", () => {
      // path is only slashes — no basename can be recovered.
      const raw = "connector:repo:abc123def:///";
      const r = formatSourceLabel(raw);
      expect(r.isConnector).toBe(false);
      expect(r.label).toBe(raw);
      expect(r.basename).toBe(raw);
    });

    it("treats a non-string-ish nullish input as empty (no throw)", () => {
      // @ts-expect-error — exercising the runtime nullish guard.
      const r = formatSourceLabel(undefined);
      expect(r.label).toBe("");
      expect(r.isConnector).toBe(false);
    });
  });

  describe("tooltip / copy: the full raw id is preserved", () => {
    it("preserves the full raw connector id in rawId for connector ids", () => {
      const raw =
        "connector:repo:cmexample0000000000acmerp:src/main/java/com/acme/ShipmentAllocationsVO.java";
      const r = formatSourceLabel(raw);
      // rawId is the lossless original — used as the title/tooltip and for copy.
      expect(r.rawId).toBe(raw);
      // The friendly label is shorter than the raw id (it is a reduction).
      expect(r.label.length).toBeLessThan(r.rawId.length);
    });

    it("preserves the full raw id in rawId for malformed ids too", () => {
      const raw = "connector:repo:weird";
      const r = formatSourceLabel(raw);
      expect(r.rawId).toBe(raw);
    });

    it("trims surrounding whitespace into rawId so copy/deep-link stays clean", () => {
      const raw = "connector:repo:abc123def:src/File.ts";
      const r = formatSourceLabel(`  ${raw}  `);
      expect(r.rawId).toBe(raw);
      expect(r.label).toBe("File.ts — 123def");
    });
  });
});

// #573 — classified on the row's stored `documents.source` when the caller has
// it; the name is parsed only for a repo row, or when the source is unknown.
describe("formatSourceLabel — source classification (#573)", () => {
  const name = "connector:repo:c1:src/NOTES.md";

  it.each(["upload", "generated", "db", "confluence", "jira"] as const)(
    "keeps a connector-shaped name as-is for a %s row",
    (source) => {
      const r = formatSourceLabel(name, { c1: "wms" }, source);
      expect(r).toEqual({ label: name, rawId: name, basename: name, isConnector: false });
    },
  );

  it("parses it for a repo row", () => {
    expect(formatSourceLabel(name, { c1: "wms" }, "repo").label).toBe("NOTES.md — wms");
  });

  it("parses it when the source is unknown (the name is the only evidence)", () => {
    expect(formatSourceLabel(name, { c1: "wms" }).label).toBe("NOTES.md — wms");
  });

  it("still labels a live-schema id whatever the source", () => {
    expect(formatSourceLabel("live-schema:p1", undefined, "upload").label).toBe("Live schema");
  });
});
