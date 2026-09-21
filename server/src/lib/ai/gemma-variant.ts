/**
 * GPU-aware local Gemma variant selection (Issue #193 / Epic #183, Initiative B).
 *
 * Pure, side-effect-free helper that maps an observed hardware profile (total
 * VRAM, GPU count, compute capability) to a recommended Ollama Gemma model tag
 * for the `local-gemma` provider — used to choose a per-machine
 * `LOCAL_GEMMA_MODEL` override.
 *
 * IMPORTANT (cross-cutting Definition of Done for Epic #183): this module does
 * NOT change any default. `DEFAULT_LOCAL_GEMMA_MODEL` in `config.ts` stays
 * `gemma4:12b` for macOS/Linux. This is an OPT-IN advisory: an operator runs
 * `recommendGemmaVariant(detectGpuProfileFromNvidiaSmi(...))` (or reads the
 * docs) and sets `LOCAL_GEMMA_MODEL` for their box only.
 *
 * Model-tag verification (June 2026, against installed Ollama 0.20.4):
 *   - `gemma4:12b`  — VERIFIED real published tag (~7.4 GB model layer, vision-
 *                     capable, Q-quant). Fits one 12 GB card. This is the
 *                     codebase default and is CORRECT; left unchanged.
 *   - `gemma4:26b`  — VERIFIED installed (17 GB, Q4_K_M, 25.8B params, 256k ctx).
 *                     Needs ~24 GB → split across 2× RTX 3060 (12 GB each).
 *   - `gemma4:e4b`  — VERIFIED installed (9.6 GB, Q4_K_M, 8B-class). Fallback
 *                     for a single smaller card.
 *
 * Target box for this epic: 2× NVIDIA RTX 3060 12 GB (24 GB total), CUDA
 * compute capability 8.6 — both verified via `nvidia-smi`.
 */

/** A recommendable Gemma variant with the metadata needed to pick it. */
export interface GemmaVariant {
  /** Ollama tag to set as `LOCAL_GEMMA_MODEL`. */
  readonly tag: string;
  /** Approximate VRAM (GB) needed to run the variant comfortably on GPU. */
  readonly minVramGb: number;
  /** Whether the variant benefits from / requires splitting across >1 GPU. */
  readonly multiGpu: boolean;
  /** Human-readable note for docs/logs. */
  readonly note: string;
}

/** Observed GPU hardware profile (typically parsed from `nvidia-smi`). */
export interface GpuProfile {
  /** Number of CUDA GPUs detected. 0 ⇒ CPU-only. */
  readonly gpuCount: number;
  /** Total VRAM across all GPUs, in GB. */
  readonly totalVramGb: number;
  /** Largest single-GPU VRAM, in GB (drives single-card fit). */
  readonly largestVramGb: number;
  /** Minimum CUDA compute capability across GPUs (e.g. 8.6), or null if unknown. */
  readonly computeCapability: number | null;
}

/**
 * Ordered (largest → smallest) catalogue of verified Gemma variants. The CPU
 * fallback is a small instruct model that runs without a GPU.
 */
export const GEMMA_VARIANTS: readonly GemmaVariant[] = Object.freeze([
  Object.freeze({
    tag: "gemma4:26b",
    minVramGb: 18,
    multiGpu: true,
    note: "25.8B params, Q4_K_M, 256k ctx — split across 2+ GPUs (≈24 GB total).",
  }),
  Object.freeze({
    tag: "gemma4:12b",
    minVramGb: 9,
    multiGpu: false,
    note: "12B-class, vision-capable — fits a single 12 GB card. Codebase default.",
  }),
  Object.freeze({
    tag: "gemma4:e4b",
    minVramGb: 7,
    multiGpu: false,
    note: "8B-class, Q4_K_M — fallback for a single smaller GPU.",
  }),
]);

/** The model used when no GPU is available. Smallest, CPU-runnable. */
export const CPU_FALLBACK_VARIANT: GemmaVariant = Object.freeze({
  tag: "gemma4:e4b",
  minVramGb: 0,
  multiGpu: false,
  note: "CPU-only fallback — runs without a GPU but slowly; smallest verified tag.",
});

/** RTX 3060 / Ampere compute capability; Ollama CUDA builds require ≥ 5.0. */
export const MIN_SUPPORTED_COMPUTE_CAPABILITY = 5.0;

/**
 * Recommend a Gemma variant for the given hardware profile.
 *
 * Selection rules (documented, deterministic):
 *   1. No GPU (or compute capability below the CUDA floor) ⇒ CPU fallback.
 *   2. Multi-GPU with enough COMBINED VRAM for a multi-GPU variant ⇒ pick the
 *      largest variant whose `minVramGb` ≤ total VRAM (Ollama auto-splits).
 *   3. Otherwise pick the largest variant that fits on the LARGEST single card.
 *   4. If nothing fits any GPU, fall back to CPU.
 *
 * @param profile observed GPU profile.
 * @returns the recommended variant (never throws).
 */
export function recommendGemmaVariant(profile: GpuProfile): GemmaVariant {
  const { gpuCount, totalVramGb, largestVramGb, computeCapability } = profile;

  const cudaUsable =
    gpuCount > 0 &&
    (computeCapability == null || computeCapability >= MIN_SUPPORTED_COMPUTE_CAPABILITY);

  if (!cudaUsable) return CPU_FALLBACK_VARIANT;

  // Prefer a multi-GPU variant only when we genuinely have >1 GPU AND the
  // combined VRAM covers it — Ollama splits a single large model across cards.
  if (gpuCount > 1) {
    const multi = GEMMA_VARIANTS.find((v) => v.multiGpu && totalVramGb >= v.minVramGb);
    if (multi) return multi;
  }

  // Single-card fit: largest variant that fits on the biggest individual GPU.
  const singleFit = GEMMA_VARIANTS.find((v) => !v.multiGpu && largestVramGb >= v.minVramGb);
  if (singleFit) return singleFit;

  // GPU present but too small for any GPU variant ⇒ CPU fallback.
  return CPU_FALLBACK_VARIANT;
}

/**
 * Parse `nvidia-smi --query-gpu=memory.total,compute_cap --format=csv,noheader`
 * output into a {@link GpuProfile}. Tolerant of units (`MiB`/`MB`), extra
 * whitespace, and missing compute-capability columns.
 *
 * SECURITY: this only PARSES text the caller already captured; it never
 * executes anything. The bootstrap/ops layer is responsible for invoking
 * `nvidia-smi` via an argument array (no shell).
 *
 * @param raw stdout from nvidia-smi (one GPU per line).
 * @returns parsed profile (zeroed when no GPU lines are present).
 */
export function parseNvidiaSmi(raw: string): GpuProfile {
  const lines = String(raw)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && /\d/.test(l));

  let gpuCount = 0;
  let totalVramGb = 0;
  let largestVramGb = 0;
  let computeCapability: number | null = null;

  for (const line of lines) {
    const cols = line.split(",").map((c) => c.trim());
    const memRaw = cols[0] ?? "";
    const memMatch = memRaw.match(/([\d.]+)\s*(MiB|MB|GiB|GB)?/i);
    if (!memMatch) continue;

    const value = Number.parseFloat(memMatch[1]);
    if (!Number.isFinite(value) || value <= 0) continue;
    const unit = (memMatch[2] ?? "MiB").toLowerCase();

    // Normalize to GB (decimal). MiB→GB and GiB→GB use binary→decimal scaling
    // closely enough for budgeting (12288 MiB ≈ 12.88 GB ≈ "12 GB card").
    let gb: number;
    if (unit === "gib" || unit === "gb") gb = value;
    else gb = value / 1024; // MiB / MB → GiB-ish, then treat as GB for sizing

    gpuCount += 1;
    totalVramGb += gb;
    largestVramGb = Math.max(largestVramGb, gb);

    const ccRaw = cols[1];
    if (ccRaw != null) {
      const cc = Number.parseFloat(ccRaw);
      if (Number.isFinite(cc)) {
        computeCapability = computeCapability == null ? cc : Math.min(computeCapability, cc);
      }
    }
  }

  return {
    gpuCount,
    totalVramGb: Math.round(totalVramGb * 10) / 10,
    largestVramGb: Math.round(largestVramGb * 10) / 10,
    computeCapability,
  };
}

/**
 * Convenience: parse nvidia-smi output and recommend a variant in one call.
 *
 * @param nvidiaSmiOutput raw stdout (empty string ⇒ CPU fallback).
 * @returns recommended variant + the parsed profile (for logging/docs).
 */
export function recommendFromNvidiaSmi(nvidiaSmiOutput: string): {
  variant: GemmaVariant;
  profile: GpuProfile;
} {
  const profile = parseNvidiaSmi(nvidiaSmiOutput);
  return { variant: recommendGemmaVariant(profile), profile };
}
