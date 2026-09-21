import { describe, it, expect } from "vitest";
import {
  GEMMA_VARIANTS,
  CPU_FALLBACK_VARIANT,
  MIN_SUPPORTED_COMPUTE_CAPABILITY,
  recommendGemmaVariant,
  parseNvidiaSmi,
  recommendFromNvidiaSmi,
  type GpuProfile,
} from "./gemma-variant.js";

const profile = (p: Partial<GpuProfile>): GpuProfile => ({
  gpuCount: 0,
  totalVramGb: 0,
  largestVramGb: 0,
  computeCapability: null,
  ...p,
});

describe("GEMMA_VARIANTS catalogue", () => {
  it("is ordered largest → smallest by minVramGb", () => {
    for (let i = 1; i < GEMMA_VARIANTS.length; i++) {
      expect(GEMMA_VARIANTS[i - 1].minVramGb).toBeGreaterThanOrEqual(GEMMA_VARIANTS[i].minVramGb);
    }
  });
  it("keeps gemma4:12b (the codebase default) as a single-card variant", () => {
    const v = GEMMA_VARIANTS.find((x) => x.tag === "gemma4:12b");
    expect(v).toBeDefined();
    expect(v?.multiGpu).toBe(false);
  });
});

describe("recommendGemmaVariant", () => {
  it("target box: 2× RTX 3060 (24 GB total, cc 8.6) → gemma4:26b multi-GPU", () => {
    const v = recommendGemmaVariant(
      profile({ gpuCount: 2, totalVramGb: 24, largestVramGb: 12, computeCapability: 8.6 }),
    );
    expect(v.tag).toBe("gemma4:26b");
    expect(v.multiGpu).toBe(true);
  });

  it("single 12 GB card → gemma4:12b", () => {
    const v = recommendGemmaVariant(
      profile({ gpuCount: 1, totalVramGb: 12, largestVramGb: 12, computeCapability: 8.6 }),
    );
    expect(v.tag).toBe("gemma4:12b");
  });

  it("single smaller 8 GB card → gemma4:e4b fallback", () => {
    const v = recommendGemmaVariant(
      profile({ gpuCount: 1, totalVramGb: 8, largestVramGb: 8, computeCapability: 7.5 }),
    );
    expect(v.tag).toBe("gemma4:e4b");
  });

  it("no GPU → CPU fallback", () => {
    const v = recommendGemmaVariant(profile({ gpuCount: 0 }));
    expect(v).toBe(CPU_FALLBACK_VARIANT);
  });

  it("GPU below CUDA compute floor → CPU fallback", () => {
    const v = recommendGemmaVariant(
      profile({
        gpuCount: 1,
        totalVramGb: 12,
        largestVramGb: 12,
        computeCapability: MIN_SUPPORTED_COMPUTE_CAPABILITY - 1,
      }),
    );
    expect(v).toBe(CPU_FALLBACK_VARIANT);
  });

  it("GPU present but too small for any GPU variant → CPU fallback", () => {
    const v = recommendGemmaVariant(
      profile({ gpuCount: 1, totalVramGb: 4, largestVramGb: 4, computeCapability: 8.6 }),
    );
    expect(v).toBe(CPU_FALLBACK_VARIANT);
  });

  it("two small cards whose combined VRAM still can't host 26b → single-card variant", () => {
    // 2× 8 GB = 16 GB total < 18 GB needed for 26b; each card hosts 12b? no (needs 9, 8<9) → e4b
    const v = recommendGemmaVariant(
      profile({ gpuCount: 2, totalVramGb: 16, largestVramGb: 8, computeCapability: 8.6 }),
    );
    expect(v.tag).toBe("gemma4:e4b");
  });

  it("unknown compute capability is treated as usable", () => {
    const v = recommendGemmaVariant(
      profile({ gpuCount: 1, totalVramGb: 12, largestVramGb: 12, computeCapability: null }),
    );
    expect(v.tag).toBe("gemma4:12b");
  });
});

describe("parseNvidiaSmi", () => {
  it("parses the verified target-box output (2× RTX 3060, cc 8.6)", () => {
    const raw = "12288 MiB, 8.6\n12288 MiB, 8.6\n";
    const p = parseNvidiaSmi(raw);
    expect(p.gpuCount).toBe(2);
    expect(p.largestVramGb).toBeCloseTo(12, 0);
    expect(p.totalVramGb).toBeCloseTo(24, 0);
    expect(p.computeCapability).toBe(8.6);
  });

  it("handles GB units and header/blank lines", () => {
    const raw = "\nname, memory.total, compute_cap\n24 GB, 8.9\n";
    const p = parseNvidiaSmi(raw);
    // header line has no leading digit in mem col → still parsed loosely; ensure GPU detected
    expect(p.gpuCount).toBeGreaterThanOrEqual(1);
    expect(p.largestVramGb).toBeGreaterThanOrEqual(24);
  });

  it("returns a zeroed profile for empty output", () => {
    const p = parseNvidiaSmi("");
    expect(p).toEqual({ gpuCount: 0, totalVramGb: 0, largestVramGb: 0, computeCapability: null });
  });

  it("takes the MINIMUM compute capability across mismatched GPUs", () => {
    const raw = "12288 MiB, 8.6\n8192 MiB, 7.0\n";
    const p = parseNvidiaSmi(raw);
    expect(p.computeCapability).toBe(7.0);
  });
});

describe("recommendFromNvidiaSmi", () => {
  it("composes parse + recommend for the target box", () => {
    const { variant, profile: p } = recommendFromNvidiaSmi("12288 MiB, 8.6\n12288 MiB, 8.6\n");
    expect(variant.tag).toBe("gemma4:26b");
    expect(p.gpuCount).toBe(2);
  });

  it("empty output → CPU fallback", () => {
    const { variant } = recommendFromNvidiaSmi("");
    expect(variant).toBe(CPU_FALLBACK_VARIANT);
  });
});
