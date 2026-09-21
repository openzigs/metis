/**
 * Sub-issue #275 — image allowlist + extractDockerImage parser tests.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const cfgState = { booleans: new Map<string, boolean>(), strings: new Map<string, string>() };

vi.mock("../../../src/lib/config/config-service.js", () => ({
  getConfigService: () => ({
    getBool: (k: string, def: boolean) => cfgState.booleans.get(k) ?? def,
    get: (k: string) => cfgState.strings.get(k),
    getNumber: (k: string, def: number) => def,
  }),
}));

import { assertImageAllowed } from "../../../src/lib/mcp/validation.js";
import { MCPRegistryError } from "../../../src/lib/mcp/mcp-service-error.js";
import {
  extractDockerImage,
  imageMatchesAllowlist,
  matchGlob,
  parseAllowlistCsv,
  stripImageTag,
} from "../../../src/lib/mcp/image-allowlist.js";

beforeEach(() => {
  cfgState.booleans.clear();
  cfgState.strings.clear();
});

describe("image-allowlist helpers", () => {
  describe("stripImageTag", () => {
    it("strips :tag", () => {
      expect(stripImageTag("nginx:1.27")).toBe("nginx");
    });

    it("strips @sha256 digest", () => {
      expect(
        stripImageTag(
          "ghcr.io/x/y@sha256:0000000000000000000000000000000000000000000000000000000000000000",
        ),
      ).toBe("ghcr.io/x/y");
    });

    it("preserves registry:port", () => {
      expect(stripImageTag("registry.local:5000/team/app:v1")).toBe("registry.local:5000/team/app");
    });

    it("returns input unchanged when no tag/digest", () => {
      expect(stripImageTag("ghcr.io/x/y")).toBe("ghcr.io/x/y");
    });
  });

  describe("parseAllowlistCsv", () => {
    it("returns [] for null/empty/whitespace", () => {
      expect(parseAllowlistCsv(null)).toEqual([]);
      expect(parseAllowlistCsv("")).toEqual([]);
      expect(parseAllowlistCsv("   ")).toEqual([]);
    });

    it("trims and drops empties", () => {
      expect(parseAllowlistCsv(" a , ,b ")).toEqual(["a", "b"]);
    });
  });

  describe("matchGlob", () => {
    it("translates * to [^/]* (segment-bounded)", () => {
      expect(matchGlob("ghcr.io/*/y", "ghcr.io/x/y")).toBe(true);
      expect(matchGlob("ghcr.io/*/y", "ghcr.io/x/z")).toBe(false);
    });

    it("supports prefix wildcards but does not span `/` (issue #304)", () => {
      // `*` matches a single path segment only.
      expect(matchGlob("ghcr.io/*", "ghcr.io/team")).toBe(true);
      expect(matchGlob("ghcr.io/*", "ghcr.io/team/server")).toBe(false);
    });

    it("`**` spans `/` and matches multiple segments (issue #304)", () => {
      expect(matchGlob("ghcr.io/**", "ghcr.io/team/server")).toBe(true);
      expect(matchGlob("ghcr.io/**", "ghcr.io/team/server/extra")).toBe(true);
      expect(matchGlob("ghcr.io/metis-mcps/**", "ghcr.io/metis-mcps/foo")).toBe(true);
      expect(matchGlob("ghcr.io/metis-mcps/**", "ghcr.io/metis-mcps/foo/bar")).toBe(true);
    });

    it("requires full anchor", () => {
      expect(matchGlob("ghcr.io/x/y", "ghcr.io/x/y/extra")).toBe(false);
    });
  });

  describe("imageMatchesAllowlist", () => {
    it("fails closed on empty allowlist", () => {
      expect(imageMatchesAllowlist("nginx", [])).toBe(false);
    });

    it("matches exact entry", () => {
      expect(imageMatchesAllowlist("ghcr.io/x/y", ["ghcr.io/x/y"])).toBe(true);
    });

    it("supports multi-pattern with first-match", () => {
      expect(imageMatchesAllowlist("ghcr.io/team/srv", ["other.io/*", "ghcr.io/team/*"])).toBe(
        true,
      );
    });

    it("returns false when nothing matches", () => {
      expect(imageMatchesAllowlist("docker.io/nginx", ["ghcr.io/*"])).toBe(false);
    });

    // Issue #304 — segment-aware glob semantics.
    describe("segment-aware glob semantics (issue #304)", () => {
      const SINGLE = ["ghcr.io/metis-mcps/*"] as const;
      const DOUBLE = ["ghcr.io/metis-mcps/**"] as const;

      it("`*` matches a single-segment image with tag", () => {
        expect(imageMatchesAllowlist("ghcr.io/metis-mcps/foo:tag", SINGLE)).toBe(true);
      });

      it("`*` matches a single-segment image with :latest tag", () => {
        expect(imageMatchesAllowlist("ghcr.io/metis-mcps/foo:latest", SINGLE)).toBe(true);
      });

      it("`*` matches a single-segment image pinned by digest", () => {
        const digest =
          "ghcr.io/metis-mcps/foo@sha256:0000000000000000000000000000000000000000000000000000000000000000";
        expect(imageMatchesAllowlist(digest, SINGLE)).toBe(true);
      });

      it("`*` does NOT match a multi-segment image (no longer spans `/`)", () => {
        expect(imageMatchesAllowlist("ghcr.io/metis-mcps/foo/bar:tag", SINGLE)).toBe(false);
      });

      it("`*` does NOT match an attacker-supplied path that injects extra segments", () => {
        expect(imageMatchesAllowlist("ghcr.io/metis-mcps/foo/bar/evil:tag", SINGLE)).toBe(false);
      });

      it("`**` matches single-segment images", () => {
        expect(imageMatchesAllowlist("ghcr.io/metis-mcps/foo:tag", DOUBLE)).toBe(true);
      });

      it("`**` matches multi-segment images", () => {
        expect(imageMatchesAllowlist("ghcr.io/metis-mcps/foo/bar:tag", DOUBLE)).toBe(true);
      });

      it("`**` matches digest-pinned multi-segment images", () => {
        const digest =
          "ghcr.io/metis-mcps/foo/bar@sha256:0000000000000000000000000000000000000000000000000000000000000000";
        expect(imageMatchesAllowlist(digest, DOUBLE)).toBe(true);
      });

      it("registries with port suffixes match correctly", () => {
        expect(
          imageMatchesAllowlist("registry.local:5000/team/app:v1", ["registry.local:5000/*/app"]),
        ).toBe(true);
        // The port `:5000` is part of the pattern segment, not a tag.
        expect(
          imageMatchesAllowlist("registry.local:5000/team/app:v1", ["registry.local:5000/*"]),
        ).toBe(false);
        expect(
          imageMatchesAllowlist("registry.local:5000/team/app:v1", ["registry.local:5000/**"]),
        ).toBe(true);
      });

      it("empty image string fails closed", () => {
        expect(imageMatchesAllowlist("", SINGLE)).toBe(false);
      });

      it("missing tag still matches when pattern allows it", () => {
        expect(imageMatchesAllowlist("ghcr.io/metis-mcps/foo", SINGLE)).toBe(true);
      });

      it("loose-semantics escape attempt is rejected", () => {
        // Before #304 the loose `*` would have matched these.
        expect(imageMatchesAllowlist("ghcr.io/metis-mcps/legit/../../evil:tag", SINGLE)).toBe(
          false,
        );
        expect(imageMatchesAllowlist("ghcr.io/metis-mcps/evil-org/lib:tag", SINGLE)).toBe(false);
      });
    });
  });

  describe("extractDockerImage", () => {
    it("returns null when args is empty", () => {
      expect(extractDockerImage([])).toBeNull();
    });

    it("returns null for null/undefined", () => {
      expect(extractDockerImage(null)).toBeNull();
      expect(extractDockerImage(undefined)).toBeNull();
    });

    it("extracts image after `run`", () => {
      expect(extractDockerImage(["run", "--rm", "nginx:1.27"])).toBe("nginx:1.27");
    });

    it("skips bool flags before image", () => {
      expect(extractDockerImage(["run", "-d", "-i", "--rm", "--init", "ghcr.io/x/y"])).toBe(
        "ghcr.io/x/y",
      );
    });

    it("stops at -- separator", () => {
      expect(extractDockerImage(["run", "--", "ghcr.io/x/y"])).toBeNull();
    });

    it("stops at -c", () => {
      expect(extractDockerImage(["run", "-c", "ghcr.io/x/y"])).toBeNull();
    });
  });
});

describe("assertImageAllowed (#275)", () => {
  it("is a no-op when command is not docker", () => {
    cfgState.strings.set("MCP_IMAGE_ALLOWLIST", "");
    expect(() => assertImageAllowed({ command: "node", args: ["server.js"] })).not.toThrow();
  });

  it("rejects docker command when allowlist is empty (fail-closed)", () => {
    cfgState.strings.set("MCP_IMAGE_ALLOWLIST", "");
    expect(() => assertImageAllowed({ command: "docker", args: ["run", "--rm", "nginx"] })).toThrow(
      MCPRegistryError,
    );
  });

  it("rejects when image cannot be extracted", () => {
    cfgState.strings.set("MCP_IMAGE_ALLOWLIST", "*");
    try {
      assertImageAllowed({ command: "docker", args: ["run", "--"] });
      expect.fail("expected throw");
    } catch (err) {
      const e = err as MCPRegistryError;
      expect(e.code).toBe("IMAGE_NOT_ALLOWED");
    }
  });

  it("accepts when image matches an allowlist pattern", () => {
    cfgState.strings.set("MCP_IMAGE_ALLOWLIST", "ghcr.io/team/*");
    expect(() =>
      assertImageAllowed({
        command: "docker",
        args: ["run", "--rm", "ghcr.io/team/srv:1.0"],
      }),
    ).not.toThrow();
  });

  it("rejects when image does not match any pattern", () => {
    cfgState.strings.set("MCP_IMAGE_ALLOWLIST", "ghcr.io/team/*");
    try {
      assertImageAllowed({
        command: "docker",
        args: ["run", "--rm", "docker.io/library/nginx"],
      });
      expect.fail("expected throw");
    } catch (err) {
      const e = err as MCPRegistryError;
      expect(e.status).toBe(400);
      expect(e.code).toBe("IMAGE_NOT_ALLOWED");
    }
  });
});
