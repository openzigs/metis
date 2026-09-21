/**
 * Issue #392 — image denylist + override tests.
 *
 * Covers the four acceptance criteria:
 *   (a) deny match by exact tag (vulnerable range hits)
 *   (b) allow when above patched version
 *   (c) override env opt-out emits a WARN audit event
 *   (d) untagged or non-vulnerable images pass
 *
 * Plus the wiring through `assertImageNotDenied` (validation layer) so the
 * `MCPRegistryError(422, MCP_IMAGE_DENIED)` contract is exercised end-to-end.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const cfgState = { strings: new Map<string, string>() };
const auditCalls: Array<{
  actor: unknown;
  action: string;
  target: { type: string; id: string };
  metadata?: Record<string, unknown>;
}> = [];

vi.mock("../../../src/lib/config/config-service.js", () => ({
  getConfigService: () => ({
    getBool: (_k: string, def: boolean) => def,
    get: (k: string) => cfgState.strings.get(k),
    getNumber: (_k: string, def: number) => def,
  }),
}));

vi.mock("../../../src/lib/audit/audit-service.js", () => ({
  audit: (input: {
    actor: unknown;
    action: string;
    target: { type: string; id: string };
    metadata?: Record<string, unknown>;
  }) => {
    auditCalls.push(input);
  },
}));

import {
  DEFAULT_DENYLIST,
  isImageDenied,
  isOverrideMatch,
  parseImageVersion,
  parseOverrideCsv,
} from "../../../src/lib/mcp/image-denylist.js";
import { assertImageNotDenied, assertRawImageNotDenied } from "../../../src/lib/mcp/validation.js";
import { MCPRegistryError } from "../../../src/lib/mcp/mcp-service-error.js";

beforeEach(() => {
  cfgState.strings.clear();
  auditCalls.length = 0;
});

describe("image-denylist helpers", () => {
  describe("parseImageVersion", () => {
    it("returns the tag for `repo:tag`", () => {
      expect(parseImageVersion("excel-mcp-server:0.1.5")).toBe("0.1.5");
    });

    it("returns the tag for `registry/path/repo:tag`", () => {
      expect(parseImageVersion("ghcr.io/foo/n8n-mcp:2.47.3")).toBe("2.47.3");
    });

    it("returns null for digest-pinned references", () => {
      expect(
        parseImageVersion(
          "ghcr.io/foo/excel-mcp-server@sha256:0000000000000000000000000000000000000000000000000000000000000000",
        ),
      ).toBeNull();
    });

    it("returns null for untagged images", () => {
      expect(parseImageVersion("excel-mcp-server")).toBeNull();
      expect(parseImageVersion("ghcr.io/foo/excel-mcp-server")).toBeNull();
    });

    it("preserves registry:port without confusing it for a tag", () => {
      expect(parseImageVersion("registry.local:5000/team/app:v1")).toBe("v1");
    });
  });

  describe("parseOverrideCsv", () => {
    it("returns [] for null/empty/whitespace", () => {
      expect(parseOverrideCsv(null)).toEqual([]);
      expect(parseOverrideCsv("")).toEqual([]);
      expect(parseOverrideCsv("  ")).toEqual([]);
    });

    it("parses image@version tokens", () => {
      expect(parseOverrideCsv("excel-mcp-server@0.1.7,n8n-mcp@2.47.3")).toEqual([
        { image: "excel-mcp-server", version: "0.1.7" },
        { image: "n8n-mcp", version: "2.47.3" },
      ]);
    });

    it("drops tokens missing the @ separator", () => {
      expect(parseOverrideCsv("excel-mcp-server, foo@1.0,bar@")).toEqual([
        { image: "foo", version: "1.0" },
      ]);
    });
  });

  describe("isImageDenied", () => {
    it("(a) denies an exact-tag match in the vulnerable range", () => {
      const v = isImageDenied("excel-mcp-server:0.1.5");
      expect(v).not.toBeNull();
      expect(v?.cve).toBe("CVE-2026-40576");
      expect(v?.version).toBe("0.1.5");
    });

    it("(a) denies registry-prefixed images by basename match", () => {
      const v = isImageDenied("ghcr.io/team/n8n-mcp:2.47.3");
      expect(v?.cve).toBe("CVE-2026-39974");
    });

    it("(b) ALLOWS a version above the patched range", () => {
      expect(isImageDenied("excel-mcp-server:0.1.8")).toBeNull();
      expect(isImageDenied("excel-mcp-server:1.0.0")).toBeNull();
      expect(isImageDenied("n8n-mcp:2.47.4")).toBeNull();
      expect(isImageDenied("mcp-java:1.0.0")).toBeNull();
    });

    it("(d) ignores untagged images even when the entry is wildcard", () => {
      // mcp-server-git is wildcard-vulnerable; still untagged passes.
      expect(isImageDenied("mcp-server-git")).toBeNull();
    });

    it("(d) digest-pinned images are denied against non-wildcard entries (deny-by-default)", () => {
      // Pre-#392-followup behaviour was to bypass digests on the assumption
      // that the operator had verified the artefact out-of-band. Reviewer
      // pointed out that for a NON-wildcard entry this still lets a known
      // CVE through if the digest happens to be a vulnerable build, so we
      // now deny-by-default and require an explicit override.
      const digest =
        "ghcr.io/foo/excel-mcp-server@sha256:0000000000000000000000000000000000000000000000000000000000000000";
      const v = isImageDenied(digest);
      expect(v?.cve).toBe("CVE-2026-40576");
      expect(v?.reason).toBe("unparseable_tag");
    });

    it("(d) does not deny look-alike basenames", () => {
      expect(isImageDenied("excel-mcp-server-clone:0.1.0")).toBeNull();
    });

    it("denies wildcard entries when the image is tagged", () => {
      const v = isImageDenied("mcp-server-git:1.0.0");
      expect(v?.cve).toBe("CVE-2025-68143");
      expect(v?.reason).toBe("vulnerable_range");
    });

    it("returns null for empty input", () => {
      expect(isImageDenied("")).toBeNull();
    });

    // ── unparseable-tag deny-by-default regressions ──────────────────────

    it("denies `:latest` against a non-wildcard entry citing the CVE", () => {
      const v = isImageDenied("excel-mcp-server:latest");
      expect(v).not.toBeNull();
      expect(v?.cve).toBe("CVE-2026-40576");
      expect(v?.version).toBe("latest");
      expect(v?.reason).toBe("unparseable_tag");
    });

    it("denies `:nightly` against a non-wildcard entry", () => {
      const v = isImageDenied("excel-mcp-server:nightly");
      expect(v?.cve).toBe("CVE-2026-40576");
      expect(v?.reason).toBe("unparseable_tag");
      expect(v?.version).toBe("nightly");
    });

    it("denies digest-pinned references against a non-wildcard entry", () => {
      const digest =
        "excel-mcp-server@sha256:0000000000000000000000000000000000000000000000000000000000000000";
      const v = isImageDenied(digest);
      expect(v?.cve).toBe("CVE-2026-40576");
      expect(v?.reason).toBe("unparseable_tag");
      expect(v?.version).toMatch(/^sha256:/);
    });

    it("wildcard entries are unaffected — `mcp-server-git` (wildcard) untagged still passes", () => {
      // Regression guard for the unparseable-tag fix: wildcard entries must
      // keep their untagged/digest bypass so operators can pin a digest
      // they have verified out-of-band against an advisory with no patched
      // range.
      expect(isImageDenied("mcp-server-git")).toBeNull();
      const digest =
        "mcp-server-git@sha256:0000000000000000000000000000000000000000000000000000000000000000";
      expect(isImageDenied(digest)).toBeNull();
    });

    it("seed list covers the advisories from the issue body", () => {
      const cves = DEFAULT_DENYLIST.map((e) => e.cve);
      for (const expected of [
        "CVE-2026-40576",
        "CVE-2026-39974",
        "CVE-2025-68143",
        "CVE-2026-25536",
        "CVE-2026-33252",
        "CVE-2026-35568",
        "CVE-2025-49596",
      ]) {
        expect(cves).toContain(expected);
      }
    });
  });

  describe("isOverrideMatch", () => {
    it("matches by basename + version", () => {
      const verdict = isImageDenied("ghcr.io/team/excel-mcp-server:0.1.7")!;
      expect(verdict).not.toBeNull();
      expect(isOverrideMatch(verdict, [{ image: "excel-mcp-server", version: "0.1.7" }])).toBe(
        true,
      );
    });

    it("does not match when the version differs", () => {
      const verdict = isImageDenied("excel-mcp-server:0.1.7")!;
      expect(isOverrideMatch(verdict, [{ image: "excel-mcp-server", version: "0.1.6" }])).toBe(
        false,
      );
    });
  });
});

describe("assertImageNotDenied (#392 validation wiring)", () => {
  const okCtx = { actorId: "user-1", source: "registration" as const };

  it("is a no-op when command is not docker", () => {
    expect(() =>
      assertImageNotDenied({ command: "node", args: ["server.js"] }, okCtx),
    ).not.toThrow();
    expect(auditCalls).toHaveLength(0);
  });

  it("(a) throws MCPRegistryError(422, MCP_IMAGE_DENIED) for a denied image", () => {
    let caught: unknown = null;
    try {
      assertImageNotDenied(
        { command: "docker", args: ["run", "--rm", "excel-mcp-server:0.1.5"] },
        okCtx,
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MCPRegistryError);
    const err = caught as MCPRegistryError;
    expect(err.status).toBe(422);
    expect(err.code).toBe("MCP_IMAGE_DENIED");
    expect(err.message).toContain("CVE-2026-40576");
    expect(auditCalls).toHaveLength(0);
  });

  it("(b) allows a patched version through silently (no audit event)", () => {
    expect(() =>
      assertImageNotDenied({ command: "docker", args: ["run", "--rm", "n8n-mcp:2.47.4"] }, okCtx),
    ).not.toThrow();
    expect(auditCalls).toHaveLength(0);
  });

  it("(c) override env admits a vulnerable image AND emits a WARN audit event", () => {
    cfgState.strings.set("MCP_IMAGE_DENYLIST_OVERRIDE", "excel-mcp-server@0.1.7");
    expect(() =>
      assertImageNotDenied(
        { command: "docker", args: ["run", "--rm", "excel-mcp-server:0.1.7"] },
        { actorId: "admin-42", source: "registration", serverLabel: "Excel MCP" },
      ),
    ).not.toThrow();
    expect(auditCalls).toHaveLength(1);
    const evt = auditCalls[0];
    expect(evt.action).toBe("mcp.image_denylist_overridden");
    expect(evt.target).toEqual({ type: "mcp_image", id: "excel-mcp-server:0.1.7" });
    expect(evt.actor).toBe("admin-42");
    expect(evt.metadata).toMatchObject({
      cve: "CVE-2026-40576",
      version: "0.1.7",
      source: "registration",
      serverLabel: "Excel MCP",
    });
  });

  it("(c) override that does NOT match the version still throws", () => {
    cfgState.strings.set("MCP_IMAGE_DENYLIST_OVERRIDE", "excel-mcp-server@0.1.6");
    expect(() =>
      assertImageNotDenied(
        { command: "docker", args: ["run", "--rm", "excel-mcp-server:0.1.7"] },
        okCtx,
      ),
    ).toThrow(MCPRegistryError);
  });

  it("(d) untagged docker image passes (no version to evaluate)", () => {
    // Allowlist would still reject `mcp-server-git` for being untagged-ish,
    // but the denylist itself must not throw on this case.
    expect(() =>
      assertImageNotDenied({ command: "docker", args: ["run", "--rm", "mcp-server-git"] }, okCtx),
    ).not.toThrow();
  });

  it("override env entry `excel-mcp-server@latest` opts out of the unparseable-tag deny + emits audit", () => {
    cfgState.strings.set("MCP_IMAGE_DENYLIST_OVERRIDE", "excel-mcp-server@latest");
    expect(() =>
      assertImageNotDenied(
        { command: "docker", args: ["run", "--rm", "excel-mcp-server:latest"] },
        { actorId: "admin-99", source: "registration", serverLabel: "Excel MCP" },
      ),
    ).not.toThrow();
    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0].action).toBe("mcp.image_denylist_overridden");
    expect(auditCalls[0].metadata).toMatchObject({
      cve: "CVE-2026-40576",
      version: "latest",
      source: "registration",
    });
  });

  it("error message for unparseable tag tells the operator to pin a semver tag", () => {
    let caught: unknown = null;
    try {
      assertImageNotDenied(
        { command: "docker", args: ["run", "--rm", "excel-mcp-server:nightly"] },
        okCtx,
      );
    } catch (err) {
      caught = err;
    }
    const err = caught as MCPRegistryError;
    expect(err).toBeInstanceOf(MCPRegistryError);
    expect(err.code).toBe("MCP_IMAGE_DENIED");
    expect(err.message).toContain("CVE-2026-40576");
    expect(err.message).toContain("'nightly'");
    expect(err.message).toContain("Pin a specific semver tag");
    expect(err.message).toContain("MCP_IMAGE_DENYLIST_OVERRIDE='excel-mcp-server@nightly'");
  });
});

describe("assertRawImageNotDenied (#392 provisioner pre-flight)", () => {
  it("blocks a vulnerable image at provision time even when registered earlier", () => {
    expect(() =>
      assertRawImageNotDenied("excel-mcp-server:0.1.5", {
        actorId: null,
        source: "provision",
        serverId: "mcp_abc123",
        serverLabel: "Stale registration",
      }),
    ).toThrow(MCPRegistryError);
  });

  it("override admits at provision time + emits audit (system actor)", () => {
    cfgState.strings.set("MCP_IMAGE_DENYLIST_OVERRIDE", "excel-mcp-server@0.1.5");
    expect(() =>
      assertRawImageNotDenied("excel-mcp-server:0.1.5", {
        actorId: null,
        source: "provision",
        serverId: "mcp_abc123",
        serverLabel: "Stale registration",
      }),
    ).not.toThrow();
    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0].action).toBe("mcp.image_denylist_overridden");
    expect(auditCalls[0].metadata).toMatchObject({
      source: "provision",
      serverId: "mcp_abc123",
    });
  });

  it("no-ops on null/empty image", () => {
    expect(() =>
      assertRawImageNotDenied(null, { actorId: null, source: "provision" }),
    ).not.toThrow();
    expect(() => assertRawImageNotDenied("", { actorId: null, source: "provision" })).not.toThrow();
  });
});
