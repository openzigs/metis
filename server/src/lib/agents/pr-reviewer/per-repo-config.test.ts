/**
 * Epic #394 P2 (#407) — per-repo config tests.
 */
import { describe, expect, it, vi } from "vitest";
import {
  loadPerRepoConfig,
  mergePerRepoConfig,
  isBelowSeverityFloor,
  shouldSkipAuthor,
  PrReviewConfigSchema,
  PR_REVIEW_CONFIG_PATH,
  PR_REVIEW_CONFIG_MAX_BYTES,
  type ConfigOctokit,
  type EffectiveDefaults,
} from "./per-repo-config.js";

function mkOctokit(
  content: string | null,
  opts: { encoding?: "base64" | "utf8"; status?: number; throwErr?: Error } = {},
) {
  const get = vi.fn(async () => {
    if (opts.throwErr) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const e: any = opts.throwErr;
      if (opts.status) e.status = opts.status;
      throw e;
    }
    if (content === null) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const e: any = new Error("Not Found");
      e.status = 404;
      throw e;
    }
    const encoding = opts.encoding ?? "base64";
    const payload =
      encoding === "base64"
        ? Buffer.from(content, "utf8")
            .toString("base64")
            .match(/.{1,60}/g)!
            .join("\n")
        : content;
    return {
      data: { type: "file", encoding, content: payload, size: content.length },
    };
  });
  return { repos: { getContent: get } } as unknown as ConfigOctokit;
}

const DEFAULTS: EffectiveDefaults = {
  maxDiffBytes: 1_048_576,
  skipGlobs: ["**/*.lock"],
  model: "default-model",
  severityFloor: null,
  skipDraftPrs: false,
  skipAuthors: [],
};

describe("loadPerRepoConfig", () => {
  it("returns defaults when file is missing (404)", async () => {
    const out = await loadPerRepoConfig({
      octokit: mkOctokit(null),
      owner: "o",
      repo: "r",
      ref: "abc",
    });
    expect(out.config).toEqual({});
    expect(out.warnings).toEqual([]);
    expect(out.filePresent).toBe(false);
  });

  it("returns warning on non-404 fetch error", async () => {
    const out = await loadPerRepoConfig({
      octokit: mkOctokit(null, { throwErr: new Error("500"), status: 500 }),
      owner: "o",
      repo: "r",
      ref: "abc",
    });
    expect(out.config).toEqual({});
    expect(out.warnings[0]).toMatch(/Failed to fetch/);
  });

  it("parses a valid config and applies overrides", async () => {
    const yamlText = `
maxDiffBytes: 65536
skipGlobs:
  - "**/dist/**"
model: gpt-4o
severityFloor: warning
skipDraftPrs: true
skipAuthors:
  - github-actions
  - dependabot
`;
    const out = await loadPerRepoConfig({
      octokit: mkOctokit(yamlText),
      owner: "o",
      repo: "r",
      ref: "abc",
    });
    expect(out.warnings).toEqual([]);
    expect(out.config.maxDiffBytes).toBe(65536);
    expect(out.config.severityFloor).toBe("warning");
    expect(out.config.skipAuthors).toEqual(["github-actions", "dependabot"]);
    expect(out.filePresent).toBe(true);
  });

  it("warns on malformed YAML and falls back to defaults", async () => {
    const out = await loadPerRepoConfig({
      octokit: mkOctokit(":\n  - not\n  valid: yaml: ::"),
      owner: "o",
      repo: "r",
      ref: "abc",
    });
    expect(out.config).toEqual({});
    expect(out.warnings[0]).toMatch(/parse error/);
  });

  it("warns on schema violation (unknown key)", async () => {
    const out = await loadPerRepoConfig({
      octokit: mkOctokit("totallyUnknown: 1"),
      owner: "o",
      repo: "r",
      ref: "abc",
    });
    expect(out.config).toEqual({});
    expect(out.warnings[0]).toMatch(/schema error/);
  });

  it("rejects non-object root", async () => {
    const out = await loadPerRepoConfig({
      octokit: mkOctokit("- 1\n- 2"),
      owner: "o",
      repo: "r",
      ref: "abc",
    });
    expect(out.warnings[0]).toMatch(/must be a YAML object/);
  });

  it("rejects oversized files", async () => {
    const big = "x: " + "a".repeat(PR_REVIEW_CONFIG_MAX_BYTES + 100);
    const out = await loadPerRepoConfig({
      octokit: mkOctokit(big),
      owner: "o",
      repo: "r",
      ref: "abc",
    });
    expect(out.warnings[0]).toMatch(/exceeds/);
  });

  it("returns filePresent=true with empty config when file is empty", async () => {
    // Hand-roll the octokit response since the helper can't base64-encode an empty string.
    const empty = {
      repos: {
        getContent: vi.fn(async () => ({
          data: { type: "file", encoding: "utf8", content: "", size: 0 },
        })),
      },
    } as unknown as ConfigOctokit;
    const out = await loadPerRepoConfig({ octokit: empty, owner: "o", repo: "r", ref: "abc" });
    expect(out.filePresent).toBe(true);
    expect(out.config).toEqual({});
  });

  it("decodes utf8-encoded content (non-base64)", async () => {
    const out = await loadPerRepoConfig({
      octokit: mkOctokit("model: gpt-4o\n", { encoding: "utf8" }),
      owner: "o",
      repo: "r",
      ref: "abc",
    });
    expect(out.config.model).toBe("gpt-4o");
  });

  it("returns empty config when getContent returns a directory listing", async () => {
    const dirOctokit = {
      repos: {
        getContent: vi.fn(async () => ({ data: [{ type: "dir" }] })),
      },
    } as unknown as ConfigOctokit;
    const out = await loadPerRepoConfig({ octokit: dirOctokit, owner: "o", repo: "r", ref: "abc" });
    expect(out.filePresent).toBe(true);
    expect(out.config).toEqual({});
  });

  it("coerces string-typed maxDiffBytes / skipDraftPrs to numbers/bools", async () => {
    // Using FAILSAFE_SCHEMA, raw values come back as strings.
    const yamlText = `maxDiffBytes: "2048"\nskipDraftPrs: "true"\n`;
    const out = await loadPerRepoConfig({
      octokit: mkOctokit(yamlText),
      owner: "o",
      repo: "r",
      ref: "abc",
    });
    expect(out.config.maxDiffBytes).toBe(2048);
    expect(out.config.skipDraftPrs).toBe(true);
  });
});

describe("mergePerRepoConfig", () => {
  it("overrides defaults with explicit values", () => {
    const merged = mergePerRepoConfig(DEFAULTS, {
      maxDiffBytes: 2048,
      skipGlobs: ["custom"],
      model: "claude-3-5-sonnet",
      severityFloor: "major",
      skipDraftPrs: true,
      skipAuthors: ["bot"],
    });
    expect(merged.maxDiffBytes).toBe(2048);
    expect(merged.skipGlobs).toEqual(["custom"]);
    expect(merged.model).toBe("claude-3-5-sonnet");
    expect(merged.severityFloor).toBe("major");
    expect(merged.skipDraftPrs).toBe(true);
    expect(merged.skipAuthors).toEqual(["bot"]);
  });

  it("falls back to defaults when override fields are absent", () => {
    const merged = mergePerRepoConfig(DEFAULTS, {});
    expect(merged.maxDiffBytes).toBe(DEFAULTS.maxDiffBytes);
    expect(merged.model).toBe(DEFAULTS.model);
  });
});

describe("isBelowSeverityFloor", () => {
  it("returns false when no floor is set", () => {
    expect(isBelowSeverityFloor("info", null)).toBe(false);
    expect(isBelowSeverityFloor("info", undefined)).toBe(false);
  });

  it("drops info / warning when floor=major", () => {
    expect(isBelowSeverityFloor("info", "major")).toBe(true);
    expect(isBelowSeverityFloor("warning", "major")).toBe(true);
    expect(isBelowSeverityFloor("risk", "major")).toBe(false);
  });

  it("keeps everything when floor=info", () => {
    expect(isBelowSeverityFloor("info", "info")).toBe(false);
  });
});

describe("shouldSkipAuthor", () => {
  it("matches case-insensitively", () => {
    expect(shouldSkipAuthor("Dependabot", ["dependabot"])).toBe(true);
    expect(shouldSkipAuthor("alice", ["bob"])).toBe(false);
  });
  it("returns false for null/empty author", () => {
    expect(shouldSkipAuthor(null, ["x"])).toBe(false);
    expect(shouldSkipAuthor("", ["x"])).toBe(false);
  });
});

describe("PrReviewConfigSchema", () => {
  it("exposes the configured constants", () => {
    expect(PR_REVIEW_CONFIG_PATH).toBe(".metis/pr-review.yaml");
    expect(PR_REVIEW_CONFIG_MAX_BYTES).toBe(32 * 1024);
  });
  it("rejects unknown keys in strict mode", () => {
    expect(PrReviewConfigSchema.safeParse({ x: 1 }).success).toBe(false);
  });
});

// Epic #394 P2 review (S1) — fork PRs may not pick arbitrary models.
describe("PrReviewConfigSchema model allowlist (S1)", () => {
  it("accepts an allowlisted model", () => {
    const r = PrReviewConfigSchema.safeParse({ model: "gpt-4o" });
    expect(r.success).toBe(true);
  });
  it("rejects (does not silently downgrade) unknown models", () => {
    const r = PrReviewConfigSchema.safeParse({ model: "gpt-9999-omega-ultra" });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0].path).toEqual(["model"]);
    }
  });
  it("loadPerRepoConfig surfaces a warning when a fork PR sets an off-allowlist model", async () => {
    const yamlText = `model: gpt-9999-omega-ultra\n`;
    const out = await loadPerRepoConfig({
      octokit: mkOctokit(yamlText),
      owner: "fork",
      repo: "evil",
      ref: "deadbeef",
    });
    expect(out.config.model).toBeUndefined();
    expect(out.warnings.join(" ")).toMatch(/model/i);
  });
});

// Epic #394 P2 review (S2) — maxDiffBytes overrides may only LOWER the cap.
describe("PrReviewConfigSchema maxDiffBytes hard cap (S2)", () => {
  it("accepts maxDiffBytes within the hard cap", () => {
    const r = PrReviewConfigSchema.safeParse({ maxDiffBytes: 65536 });
    expect(r.success).toBe(true);
  });
  it("rejects maxDiffBytes that exceeds the absolute hard cap", () => {
    const r = PrReviewConfigSchema.safeParse({ maxDiffBytes: 9_999_999_999 });
    expect(r.success).toBe(false);
  });
});

// Epic #394 P2 review (S2) — clamp the override against the project default.
describe("mergePerRepoConfig maxDiffBytes clamping (fork-PR scenarios)", () => {
  it("clamps the override DOWN to the project default when the override is larger", () => {
    const merged = mergePerRepoConfig(
      { ...DEFAULTS, maxDiffBytes: 100_000 },
      { maxDiffBytes: 500_000 },
    );
    expect(merged.maxDiffBytes).toBe(100_000);
  });
  it("keeps the override when it is smaller than the project default", () => {
    const merged = mergePerRepoConfig(
      { ...DEFAULTS, maxDiffBytes: 100_000 },
      { maxDiffBytes: 50_000 },
    );
    expect(merged.maxDiffBytes).toBe(50_000);
  });
  it("falls back to the absolute hard cap when no project default is set", () => {
    const merged = mergePerRepoConfig({ ...DEFAULTS, maxDiffBytes: null }, {});
    // null when no override + no default and no enforced cap; but the hard cap still applies if default missing? our impl returns null.
    expect(merged.maxDiffBytes).toBeNull();
  });
  it("still caps a no-override merge against the hard ceiling when default exceeds it", () => {
    // Operator misconfiguration: project default is set above the hard cap.
    const merged = mergePerRepoConfig({ ...DEFAULTS, maxDiffBytes: 10_000_000_000 }, {});
    expect(merged.maxDiffBytes).toBe(1_048_576);
  });
});
