/**
 * #333 — Hybrid per-section provider routing in doc-gen.
 *
 * Verifies the routing SEAM without live model serving (mirrors the Teams/Slack
 * live-dependency pattern: assert the ROUTING decision + the selected provider,
 * not real model output). Providers construct without network I/O, so we build
 * a real {@link resolvePhase2Router} from env and assert which bundle each
 * section group of each docType is dispatched to.
 *
 * Coverage focus (the AC matrix):
 *   - `tierForSection` maps every SectionGroup shape to the right tier.
 *   - Flag OFF                       → single-provider path, unchanged.
 *   - Flag ON + both providers       → literal/reconstruction → local,
 *                                       narrative → escalation (Sonnet).
 *   - Flag ON + only one provider    → graceful single-provider fallback.
 *   - Per-provider tuning is applied to whichever provider a section uses.
 *   - The loopback/RFC-1918 guard still gates the local base URL.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  resolvePhase2Router,
  providerForSection,
  sectionGroupsFor,
  type DocType,
} from "./holistic-synthesizer.js";
import { tierForSection } from "./grounding/degraded-warnings.js";

const ENV_KEYS = [
  "DOCS_GEN_HYBRID_ROUTING",
  "AI_PROVIDER",
  "AI_MODEL",
  "AI_OFFLINE",
  "LOCAL_GEMMA_BASE_URL",
  "LOCAL_GEMMA_MODEL",
  "LOCAL_GEMMA_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "BEDROCK_GATEWAY_URL",
  "BEDROCK_GATEWAY_API_KEY",
  "BEDROCK_MODEL",
  "DOCS_GEN_LOCAL_PHASE2_MODEL",
  "DOCS_GEN_LOCAL_TEMPERATURE",
  "DOCS_GEN_ANTHROPIC_PHASE2_MODEL",
] as const;

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  // Default the global provider to offline-stub so the single-provider `primary`
  // bundle builds a harmless offline provider (no network) unless a test
  // overrides it. Hybrid bundles are built separately from LOCAL_*/ANTHROPIC_*.
  process.env.AI_PROVIDER = "offline-stub";
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const DOC_TYPES: DocType[] = ["business-requirements", "architecture", "user-guide"];

function configureBothProviders(): void {
  process.env.LOCAL_GEMMA_BASE_URL = "http://127.0.0.1:11434/v1";
  process.env.LOCAL_GEMMA_MODEL = "qwen2.5:14b";
  process.env.ANTHROPIC_API_KEY = "sk-test-key";
  process.env.ANTHROPIC_MODEL = "claude-sonnet-4-6";
}

describe("tierForSection", () => {
  it("maps narrative flag to narrative", () => {
    expect(tierForSection({ narrative: true })).toBe("narrative");
  });

  it("maps reconstruction flag to reconstruction", () => {
    expect(tierForSection({ reconstruction: true })).toBe("reconstruction");
  });

  it("maps a bare (no-flag) section to literal", () => {
    expect(tierForSection({})).toBe("literal");
  });

  it("infers reconstruction from an explicit 0.6 threshold when flags are absent", () => {
    expect(tierForSection({ faithfulnessThreshold: 0.6 })).toBe("reconstruction");
  });

  it("infers narrative from an explicit 0.4 threshold when flags are absent", () => {
    expect(tierForSection({ faithfulnessThreshold: 0.4 })).toBe("narrative");
  });

  it("narrative flag wins over reconstruction if both are somehow set", () => {
    expect(tierForSection({ narrative: true, reconstruction: true })).toBe("narrative");
  });

  it("a strict 0.8 threshold stays literal", () => {
    expect(tierForSection({ faithfulnessThreshold: 0.8 })).toBe("literal");
  });

  it("classifies every real section group of every docType into a known tier", () => {
    for (const docType of DOC_TYPES) {
      for (const group of sectionGroupsFor(docType)) {
        expect(["narrative", "reconstruction", "literal"]).toContain(tierForSection(group));
      }
    }
  });
});

describe("resolvePhase2Router — flag OFF (default) preserves single-provider behavior", () => {
  it("hybrid is null when the flag is unset even if both providers are configured", () => {
    configureBothProviders();
    // Flag intentionally unset.
    const router = resolvePhase2Router(8192);
    expect(router.hybrid).toBeNull();
    // Every section — regardless of tier — resolves to the SAME primary bundle.
    for (const docType of DOC_TYPES) {
      for (const group of sectionGroupsFor(docType)) {
        const { bundle } = providerForSection(router, group);
        expect(bundle).toBe(router.primary);
      }
    }
  });

  it("hybrid is null when the flag is explicitly falsy", () => {
    configureBothProviders();
    process.env.DOCS_GEN_HYBRID_ROUTING = "0";
    expect(resolvePhase2Router(8192).hybrid).toBeNull();
  });
});

describe("resolvePhase2Router — flag ON + both providers → per-section routing", () => {
  beforeEach(() => {
    configureBothProviders();
    process.env.DOCS_GEN_HYBRID_ROUTING = "1";
  });

  it("activates hybrid routing with distinct local + escalation bundles", () => {
    const router = resolvePhase2Router(8192);
    expect(router.hybrid).not.toBeNull();
    expect(router.hybrid!.local.kind).toBe("local");
    expect(router.hybrid!.escalation.kind).toBe("anthropic");
    expect(router.hybrid!.local).not.toBe(router.hybrid!.escalation);
  });

  it("routes narrative → escalation and literal/reconstruction → local for every docType", () => {
    const router = resolvePhase2Router(8192);
    let sawNarrative = false;
    let sawLocalTier = false;
    for (const docType of DOC_TYPES) {
      for (const group of sectionGroupsFor(docType)) {
        const { bundle, tier } = providerForSection(router, group);
        if (tier === "narrative") {
          sawNarrative = true;
          expect(bundle).toBe(router.hybrid!.escalation);
        } else {
          sawLocalTier = true;
          expect(bundle).toBe(router.hybrid!.local);
        }
      }
    }
    // The suite is only meaningful if both branches were actually exercised by
    // the real section-group definitions.
    expect(sawNarrative).toBe(true);
    expect(sawLocalTier).toBe(true);
  });

  it("applies per-provider tuning to the bundle a section uses", () => {
    process.env.DOCS_GEN_LOCAL_TEMPERATURE = "0.7";
    const router = resolvePhase2Router(8192);
    // Local tuning: the operator's LOCAL_GEMMA_MODEL and the local temperature.
    expect(router.hybrid!.local.tuning.phase2Model).toBe("qwen2.5:14b");
    expect(router.hybrid!.local.tuning.temperature).toBe(0.7);
    expect(router.hybrid!.local.supportsCaching).toBe(false);
    // Escalation tuning: Sonnet model, caching on, cloud temperature default.
    expect(router.hybrid!.escalation.tuning.phase2Model).toBe("claude-sonnet-4-6");
    expect(router.hybrid!.escalation.supportsCaching).toBe(true);
    expect(router.hybrid!.escalation.factsCharCap).toBeGreaterThan(
      router.hybrid!.local.factsCharCap,
    );
  });

  it("routes to the Bedrock gateway as escalation when no Anthropic key is set", () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_MODEL;
    process.env.BEDROCK_GATEWAY_URL = "https://bedrock.internal.example/v1";
    process.env.BEDROCK_GATEWAY_API_KEY = "gw-key";
    process.env.BEDROCK_MODEL = "us.anthropic.claude-sonnet-4-6";
    const router = resolvePhase2Router(8192);
    expect(router.hybrid).not.toBeNull();
    expect(router.hybrid!.escalation.kind).toBe("bedrock");
    expect(router.hybrid!.escalation.supportsCaching).toBe(true);
  });
});

describe("resolvePhase2Router — flag ON but only one provider → graceful fallback", () => {
  it("no hybrid when only the local provider is configured", () => {
    process.env.DOCS_GEN_HYBRID_ROUTING = "1";
    process.env.LOCAL_GEMMA_BASE_URL = "http://127.0.0.1:11434/v1";
    process.env.LOCAL_GEMMA_MODEL = "qwen2.5:14b";
    // No ANTHROPIC / BEDROCK escalation configured.
    const router = resolvePhase2Router(8192);
    expect(router.hybrid).toBeNull();
    for (const group of sectionGroupsFor("architecture")) {
      expect(providerForSection(router, group).bundle).toBe(router.primary);
    }
  });

  it("no hybrid when only the escalation provider is configured", () => {
    process.env.DOCS_GEN_HYBRID_ROUTING = "1";
    process.env.ANTHROPIC_API_KEY = "sk-test-key";
    // No LOCAL_GEMMA_BASE_URL configured.
    const router = resolvePhase2Router(8192);
    expect(router.hybrid).toBeNull();
  });
});

describe("resolvePhase2Router — loopback/RFC-1918 guard is still enforced", () => {
  it("throws when the local base URL points at a public host", () => {
    process.env.DOCS_GEN_HYBRID_ROUTING = "1";
    process.env.LOCAL_GEMMA_BASE_URL = "https://api.openai.com/v1";
    process.env.ANTHROPIC_API_KEY = "sk-test-key";
    expect(() => resolvePhase2Router(8192)).toThrow(/public LLM provider|loopback or private/i);
  });

  it("throws when the local base URL is a public (non-private) host", () => {
    process.env.DOCS_GEN_HYBRID_ROUTING = "1";
    process.env.LOCAL_GEMMA_BASE_URL = "http://93.184.216.34:11434/v1";
    process.env.ANTHROPIC_API_KEY = "sk-test-key";
    expect(() => resolvePhase2Router(8192)).toThrow(/loopback or private/i);
  });

  it("accepts an RFC-1918 private host for the local provider", () => {
    process.env.DOCS_GEN_HYBRID_ROUTING = "1";
    process.env.LOCAL_GEMMA_BASE_URL = "http://192.168.1.50:11434/v1";
    process.env.LOCAL_GEMMA_MODEL = "qwen2.5:14b";
    process.env.ANTHROPIC_API_KEY = "sk-test-key";
    const router = resolvePhase2Router(8192);
    expect(router.hybrid).not.toBeNull();
    expect(router.hybrid!.local.kind).toBe("local");
  });
});
