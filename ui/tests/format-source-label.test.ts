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
