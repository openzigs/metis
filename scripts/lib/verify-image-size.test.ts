import { describe, it, expect, vi } from "vitest";
import {
  DEFAULT_MAX_IMAGE_MB,
  bytesToMb,
  parseBudgetMb,
  isOverBudget,
  evaluateSizes,
  inspectImageBytes,
  parseHumanSizeToBytes,
  runVerify,
} from "./verify-image-size.mjs";

/**
 * Build a docker `run` stub that answers `image inspect` and `image ls` per tag.
 * `inspect[tag]` / `ls[tag]` map to the raw stdout each subcommand returns; an
 * absent key throws (mimicking docker's "No such image"). Lets the retry/fallback
 * tests express exactly which probe yields what without brittle call-order mocks.
 */
function dockerStub(spec: { inspect?: Record<string, string>; ls?: Record<string, string> }) {
  return vi.fn((args: string[]) => {
    const sub = args[1]; // "inspect" | "ls"
    if (sub === "inspect") {
      // image inspect <tag> --format {{.Size}}
      const v = spec.inspect?.[args[2]];
      if (v == null) throw new Error("No such image");
      return v;
    }
    // image ls --format {{.Size}} <tag>
    const v = spec.ls?.[args[args.length - 1]];
    if (v == null) throw new Error("no ls");
    return v;
  });
}

describe("bytesToMb", () => {
  it("uses decimal MB rounded to one decimal", () => {
    expect(bytesToMb(350_000_000)).toBe(350);
    expect(bytesToMb(329_400_000)).toBe(329.4);
  });
  it("returns 0 for non-positive / non-finite", () => {
    expect(bytesToMb(0)).toBe(0);
    expect(bytesToMb(-5)).toBe(0);
    expect(bytesToMb(Number.NaN)).toBe(0);
  });
});

describe("parseBudgetMb", () => {
  it("defaults when blank/absent/invalid", () => {
    expect(parseBudgetMb(undefined)).toBe(DEFAULT_MAX_IMAGE_MB);
    expect(parseBudgetMb("")).toBe(DEFAULT_MAX_IMAGE_MB);
    expect(parseBudgetMb("  ")).toBe(DEFAULT_MAX_IMAGE_MB);
    expect(parseBudgetMb("abc")).toBe(DEFAULT_MAX_IMAGE_MB);
    expect(parseBudgetMb("0")).toBe(DEFAULT_MAX_IMAGE_MB);
    expect(parseBudgetMb("-10")).toBe(DEFAULT_MAX_IMAGE_MB);
  });
  it("parses a valid value", () => {
    expect(parseBudgetMb("1200")).toBe(1200);
  });
});

describe("isOverBudget", () => {
  it("is strict greater-than", () => {
    expect(isOverBudget(351, 350)).toBe(true);
    expect(isOverBudget(350, 350)).toBe(false);
    expect(isOverBudget(10, 350)).toBe(false);
  });
});

describe("evaluateSizes", () => {
  it("passes when gated images are within budget", () => {
    const r = evaluateSizes(
      [
        { tag: "metis-server:test", mb: 320, exempt: false },
        { tag: "metis-ui:test", mb: 300, exempt: false },
        { tag: "metis-embeddings:test", mb: 999, exempt: true },
      ],
      350,
    );
    expect(r.ok).toBe(true);
    expect(r.failures).toEqual([]);
  });

  it("fails an over-budget gated image but ignores exempt", () => {
    const r = evaluateSizes(
      [
        { tag: "metis-server:test", mb: 400, exempt: false },
        { tag: "metis-embeddings:test", mb: 5000, exempt: true },
      ],
      350,
    );
    expect(r.ok).toBe(false);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toContain("metis-server:test");
  });

  it("fails a missing gated image", () => {
    const r = evaluateSizes([{ tag: "metis-ui:test", mb: null, exempt: false }], 350);
    expect(r.ok).toBe(false);
    expect(r.failures[0]).toContain("not found");
  });
});

describe("inspectImageBytes", () => {
  it("parses the first line and strips whitespace", () => {
    const run = dockerStub({ inspect: { "x:test": "  123456789 \n987\n" } });
    expect(inspectImageBytes("x:test", { run })).toBe(123456789);
    expect(run).toHaveBeenCalledWith(["image", "inspect", "x:test", "--format", "{{.Size}}"]);
  });

  it("returns null when both inspect and ls miss (truly absent image)", () => {
    const run = dockerStub({}); // neither inspect nor ls knows the tag → both throw
    expect(inspectImageBytes("x:test", { run })).toBeNull();
  });

  it("returns null for zero / empty inspect with no ls fallback", () => {
    // inspect yields empty/zero AND ls has nothing → null.
    expect(inspectImageBytes("x", { run: dockerStub({ inspect: { x: "0" } }) })).toBeNull();
    expect(inspectImageBytes("x", { run: dockerStub({ inspect: { x: "" } }) })).toBeNull();
  });

  it("falls back to `docker image ls` when inspect Size is empty (#509 manifest index)", () => {
    // BuildKit attestation index: `{{.Size}}` is empty but `image ls` reports a
    // human-readable size. The gate must still measure the image.
    const run = dockerStub({
      inspect: { "metis-server:test": "" },
      ls: { "metis-server:test": "329MB" },
    });
    expect(inspectImageBytes("metis-server:test", { run })).toBe(329_000_000);
  });

  it("retries a transient miss then succeeds via inspect (#509)", () => {
    // First two probes miss entirely (post-build daemon race), the third inspect
    // returns a real size. No-op sleep keeps it instant.
    const run = vi.fn((args: string[]) => {
      const sub = args[1];
      const calls = run.mock.calls.filter((c) => c[0][1] === "inspect").length;
      if (sub === "inspect" && calls >= 3) return "123456789";
      throw new Error("miss");
    });
    const sleepMs = vi.fn();
    expect(inspectImageBytes("x:test", { run, retries: 3, sleepMs })).toBe(123456789);
    // Slept between attempt 1→2 and 2→3 only (success on the 3rd).
    expect(sleepMs).toHaveBeenCalledTimes(2);
  });

  it("gives up after exhausting retries on a persistent miss (#509)", () => {
    const run = dockerStub({}); // every probe throws
    const sleepMs = vi.fn();
    expect(inspectImageBytes("x:test", { run, retries: 2, sleepMs })).toBeNull();
    // 1 initial + 2 retries = 3 attempts; sleeps between each pair = 2.
    expect(sleepMs).toHaveBeenCalledTimes(2);
  });

  it("does not retry when retries is 0 / unset", () => {
    const run = dockerStub({});
    const sleepMs = vi.fn();
    expect(inspectImageBytes("x:test", { run, sleepMs })).toBeNull();
    expect(sleepMs).not.toHaveBeenCalled();
  });
});

describe("parseHumanSizeToBytes", () => {
  it("parses decimal MB/GB/kB units", () => {
    expect(parseHumanSizeToBytes("329MB")).toBe(329_000_000);
    expect(parseHumanSizeToBytes("1.2GB")).toBe(1_200_000_000);
    expect(parseHumanSizeToBytes("67.8 MB")).toBe(67_800_000);
    expect(parseHumanSizeToBytes("512kB")).toBe(512_000);
    expect(parseHumanSizeToBytes("900B")).toBe(900);
    expect(parseHumanSizeToBytes("450")).toBe(450);
  });

  it("tolerates binary-style suffixes (MiB) as decimal", () => {
    expect(parseHumanSizeToBytes("329MiB")).toBe(329_000_000);
  });

  it("returns null for empty / zero / unparseable", () => {
    expect(parseHumanSizeToBytes("")).toBeNull();
    expect(parseHumanSizeToBytes("0B")).toBeNull();
    expect(parseHumanSizeToBytes("n/a")).toBeNull();
    expect(parseHumanSizeToBytes(undefined as unknown as string)).toBeNull();
  });

  it("reads only the first line", () => {
    expect(parseHumanSizeToBytes("329MB\n67MB")).toBe(329_000_000);
  });
});

describe("runVerify", () => {
  function makeDeps(over = false, missingDocker = false) {
    const log = vi.fn();
    const err = vi.fn();
    const build = vi.fn();
    const sizes: Record<string, string> = {
      "metis-server:test": over ? "400000000" : "320000000",
      "metis-ui:test": "300000000",
      "metis-embeddings:test": "999000000",
    };
    const run = vi.fn((args: string[]) => sizes[args[2]] ?? "");
    return {
      log,
      err,
      build,
      run,
      hasDocker: () => !missingDocker,
    };
  }

  it("returns 2 when docker is unavailable", () => {
    const deps = makeDeps(false, true);
    expect(runVerify({ deps, budgetMb: 350 })).toBe(2);
    expect(deps.err).toHaveBeenCalledWith(expect.stringContaining("docker is not installed"));
  });

  it("returns 0 and skips build with --no-build when within budget", () => {
    const deps = makeDeps(false);
    expect(runVerify({ noBuild: true, deps, budgetMb: 350 })).toBe(0);
    expect(deps.build).not.toHaveBeenCalled();
  });

  it("builds all three images when noBuild is false", () => {
    const deps = makeDeps(false);
    runVerify({ noBuild: false, deps, budgetMb: 350 });
    expect(deps.build).toHaveBeenCalledTimes(3);
  });

  it("returns 1 when a gated image is over budget", () => {
    const deps = makeDeps(true);
    expect(runVerify({ noBuild: true, deps, budgetMb: 350 })).toBe(1);
    expect(deps.err).toHaveBeenCalledWith(expect.stringContaining("exceeds"));
  });

  it("measures a manifest-index image via the ls fallback (#509)", () => {
    // metis-server's inspect Size is empty (BuildKit attestation index) but
    // `image ls` reports it — the gate must pass, not report it missing. The
    // others are sized via inspect as usual.
    const log = vi.fn();
    const err = vi.fn();
    const run = dockerStub({
      inspect: {
        "metis-server:test": "", // attestation index → empty inspect Size
        "metis-ui:test": "300000000",
        "metis-embeddings:test": "999000000",
      },
      ls: { "metis-server:test": "320MB" },
    });
    const code = runVerify({
      noBuild: true,
      budgetMb: 350,
      deps: { log, err, run, hasDocker: () => true, retries: 3, sleepMs: vi.fn() },
    });
    expect(code).toBe(0);
    expect(err).not.toHaveBeenCalledWith(expect.stringContaining("not found"));
  });

  it("reports a persistently missing image after retries (#509)", () => {
    const log = vi.fn();
    const err = vi.fn();
    // metis-server is absent from BOTH inspect and ls; the others are present.
    const run = dockerStub({
      inspect: {
        "metis-ui:test": "300000000",
        "metis-embeddings:test": "999000000",
      },
      ls: {},
    });
    const code = runVerify({
      noBuild: true,
      budgetMb: 350,
      deps: { log, err, run, hasDocker: () => true, retries: 2, sleepMs: vi.fn() },
    });
    expect(code).toBe(1);
    expect(err).toHaveBeenCalledWith(expect.stringContaining("image not found or zero size"));
  });
});
