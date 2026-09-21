/**
 * #961/#994 — deterministic requirement→code match-quality thresholds.
 *
 * `deriveMatchQualityDetailed` grades the SEED (direct-match) confidence+filePath
 * pairs into strong/moderate/weak (+ WHY, when weak) with DOCUMENTED thresholds
 * (MATCH_QUALITY_THRESHOLDS). These tests lock the exact boundaries so threshold
 * drift is a failing test, and confirm both the engine-time path (raw match
 * confidences+paths) and the read-time path (persisted direct-symbol
 * confidences+paths) agree via one function.
 *
 * #994 root cause: seed confidences are TOP-NORMALIZED (see impact.ts doc), so
 * the top seed of any non-empty set is always ~1.0 — an absolute confidence
 * floor carries no signal. The regression fixtures below reproduce the exact
 * live bug (a precise, multi-entity requirement mis-flagged `weak` because it
 * produced 8 near-tied seeds) and the genuine-scatter case the fix must still
 * catch, using the coherence discriminator (`dominantBasenameTokenShare`).
 */
import { describe, expect, it } from "vitest";
import {
  deriveMatchQuality,
  deriveMatchQualityDetailed,
  dominantBasenameTokenShare,
  dominantDirectoryShare,
  MATCH_QUALITY_THRESHOLDS as T,
  type MatchQualitySeed,
} from "./impact.js";

/** Helper: build a seed list from `[confidence, filePath]` pairs. */
function seeds(pairs: Array<[number, string]>): MatchQualitySeed[] {
  return pairs.map(([confidence, filePath]) => ({ confidence, filePath }));
}

describe("deriveMatchQualityDetailed (#961/#994)", () => {
  it("weak/no-entity: zero seeds (the requirement matched no code)", () => {
    expect(deriveMatchQualityDetailed([])).toEqual({ quality: "weak", reason: "no-entity" });
  });

  it("strong: a single seed is a clear winner by definition, whatever its confidence", () => {
    expect(deriveMatchQualityDetailed(seeds([[0.31, "src/anything.ts"]]))).toEqual({
      quality: "strong",
      reason: null,
    });
  });

  it("strong: top seed clears the runner-up by >= CLEAR_WINNER_SPREAD", () => {
    // top 0.9, runner-up 0.75 -> spread 0.15 == the margin (inclusive) -> strong.
    expect(
      deriveMatchQualityDetailed(
        seeds([
          [0.9, "a.ts"],
          [0.75, "b.ts"],
          [0.4, "c.ts"],
        ]),
      ),
    ).toEqual({ quality: "strong", reason: null });
  });

  it("moderate: top seed is high but the runner-up is within CLEAR_WINNER_SPREAD (ambiguous, few seeds)", () => {
    // spread 0.10 < 0.15, only 2 seeds (< SCATTERED_SEED_COUNT) -> moderate.
    expect(
      deriveMatchQualityDetailed(
        seeds([
          [0.9, "a.ts"],
          [0.8, "b.ts"],
        ]),
      ),
    ).toEqual({ quality: "moderate", reason: null });
  });

  it("moderate: fewer than SCATTERED_SEED_COUNT near-tied seeds are not weak", () => {
    // 4 near-tied seeds (< 5) -> not the scattered-count rule -> moderate.
    expect(
      deriveMatchQualityDetailed(
        seeds([
          [0.5, "a.ts"],
          [0.49, "b.ts"],
          [0.48, "c.ts"],
          [0.47, "d.ts"],
        ]),
      ),
    ).toEqual({ quality: "moderate", reason: null });
  });

  it("ignores non-finite confidences deterministically", () => {
    expect(
      deriveMatchQualityDetailed(
        seeds([
          [Number.NaN, "a.ts"],
          [0.72, "b.ts"],
        ]),
      ),
    ).toEqual({ quality: "strong", reason: null });
    expect(deriveMatchQualityDetailed(seeds([[Number.NaN, "a.ts"]]))).toEqual({
      quality: "weak",
      reason: "no-entity",
    });
  });

  describe("#994 regression: near-tied pack (>= SCATTERED_SEED_COUNT) — coherence discriminator", () => {
    it("moderate: the live order-cancellation bug fixture — coherent multi-file feature must NOT be weak", () => {
      // Exact live seed shape from the #994 report: 1.00/0.98/0.98/0.95/0.95/0.92/0.92/0.92
      // over Order*/LineItem*-style paths. Old rule 3 ("5+ near-tied -> weak") mis-fired
      // here; the fix must read this as one coherent feature scattered across its own
      // files, not generic wording.
      const result = deriveMatchQualityDetailed(
        seeds([
          [1.0, "server/src/services/order-service.ts"],
          [0.98, "server/src/services/order-cancellation-handler.ts"],
          [0.98, "server/src/repositories/order-repository.ts"],
          [0.95, "server/src/services/order-status-history.ts"],
          [0.95, "server/src/validators/order-validator.ts"],
          [0.92, "server/src/mappers/order-line-item-mapper.ts"],
          [0.92, "server/src/services/line-item-service.ts"],
          [0.92, "server/src/services/inventory-adjuster.ts"],
        ]),
      );
      expect(result.quality).not.toBe("weak");
      expect(result).toEqual({ quality: "moderate", reason: null });
    });

    it("weak/scattered: a genuinely vague requirement (no dominant shared entity) is STILL flagged", () => {
      // Generic wording that fans out across unrelated areas — no basename token
      // dominates the pack (matches the impact.ts doc's own scatter example).
      const result = deriveMatchQualityDetailed(
        seeds([
          [1.0, "server/src/services/account-service.ts"],
          [0.97, "server/src/controllers/item-controller.ts"],
          [0.95, "ui/src/components/orders-widget.tsx"],
          [0.94, "server/src/services/cart-manager.ts"],
          [0.93, "ui/src/components/status-badge.tsx"],
        ]),
      );
      expect(result).toEqual({ quality: "weak", reason: "scattered" });
    });

    it("documents the calibration margin between the two fixtures (no hand-waving)", () => {
      const coherent = seeds([
        [1.0, "server/src/services/order-service.ts"],
        [0.98, "server/src/services/order-cancellation-handler.ts"],
        [0.98, "server/src/repositories/order-repository.ts"],
        [0.95, "server/src/services/order-status-history.ts"],
        [0.95, "server/src/validators/order-validator.ts"],
        [0.92, "server/src/mappers/order-line-item-mapper.ts"],
        [0.92, "server/src/services/line-item-service.ts"],
        [0.92, "server/src/services/inventory-adjuster.ts"],
      ]);
      const scattered = seeds([
        [1.0, "server/src/services/account-service.ts"],
        [0.97, "server/src/controllers/item-controller.ts"],
        [0.95, "ui/src/components/orders-widget.tsx"],
        [0.94, "server/src/services/cart-manager.ts"],
        [0.93, "ui/src/components/status-badge.tsx"],
      ]);
      // "order" appears in the basename of 6/8 coherent seeds (0.75) vs. the
      // scattered pack's best token appearing in only 1/5 (0.2) — a wide margin
      // either side of DOMINANT_TOKEN_SHARE (0.5), so the default requires no
      // tuning to separate the two live-shaped fixtures.
      expect(dominantBasenameTokenShare(coherent)).toBeCloseTo(0.75, 5);
      expect(dominantBasenameTokenShare(scattered)).toBeCloseTo(0.2, 5);
      expect(dominantBasenameTokenShare(coherent)).toBeGreaterThanOrEqual(T.DOMINANT_TOKEN_SHARE);
      expect(dominantBasenameTokenShare(scattered)).toBeLessThan(T.DOMINANT_TOKEN_SHARE);
    });

    it("moderate: dominant token share exactly at DOMINANT_TOKEN_SHARE is inclusive", () => {
      // 6 seeds, "order" token in exactly 3 of 6 basenames (0.5 == the threshold).
      const result = deriveMatchQualityDetailed(
        seeds([
          [1.0, "order-a.ts"],
          [0.98, "order-b.ts"],
          [0.97, "order-c.ts"],
          [0.96, "cart-x.ts"],
          [0.95, "item-y.ts"],
          [0.94, "status-z.ts"],
        ]),
      );
      expect(
        dominantBasenameTokenShare(
          seeds([
            [1.0, "order-a.ts"],
            [0.98, "order-b.ts"],
            [0.97, "order-c.ts"],
            [0.96, "cart-x.ts"],
            [0.95, "item-y.ts"],
            [0.94, "status-z.ts"],
          ]),
        ),
      ).toBe(0.5);
      expect(result).toEqual({ quality: "moderate", reason: null });
    });
  });
});

describe("dominantBasenameTokenShare (#994)", () => {
  it("returns 0 for an empty seed list", () => {
    expect(dominantBasenameTokenShare([])).toBe(0);
  });

  it("returns 1.0 when every seed shares one basename token", () => {
    const share = dominantBasenameTokenShare(
      seeds([
        [1.0, "OrderService.ts"],
        [0.9, "OrderRepository.ts"],
      ]),
    );
    expect(share).toBe(1);
  });

  it("splits PascalCase/camelCase basenames into lowercase tokens, extension stripped", () => {
    // "OrderLineItem.ts" and "orderLineItem.tsx" both tokenize to order/line/item,
    // so the shared token dominates both seeds regardless of case/extension.
    const share = dominantBasenameTokenShare(
      seeds([
        [1.0, "src/models/OrderLineItem.ts"],
        [0.9, "src/models/orderLineItem.tsx"],
      ]),
    );
    expect(share).toBe(1);
  });

  it("counts a token at most once per seed even if repeated in the basename", () => {
    const share = dominantBasenameTokenShare(
      seeds([
        [1.0, "order-order-service.ts"],
        [0.9, "cart.ts"],
      ]),
    );
    // "order" appears twice in seed 1's basename but counts once -> share 1/2.
    expect(share).toBe(0.5);
  });
});

describe("dominantDirectoryShare (#994 — evaluated, not shipped)", () => {
  it("returns 0 for an empty seed list", () => {
    expect(dominantDirectoryShare([])).toBe(0);
  });

  it("returns 1.0 when every seed lives in the same directory", () => {
    const share = dominantDirectoryShare(
      seeds([
        [1.0, "server/src/services/order-service.ts"],
        [0.9, "server/src/services/cart-service.ts"],
      ]),
    );
    expect(share).toBe(1);
  });

  it("is rejected as the shipped discriminator: a flat layout makes scattered seeds look coherent", () => {
    // Same scattered fixture as above, but all files happen to live in one flat
    // `src/models/` directory — dominantDirectoryShare would read this as fully
    // coherent (1.0) even though the entities are unrelated, false-negativing the
    // `weak` grade the scattered regression requires. This is WHY #994 shipped
    // dominantBasenameTokenShare instead.
    const flatScattered = seeds([
      [1.0, "src/models/account.ts"],
      [0.97, "src/models/item.ts"],
      [0.95, "src/models/orders.ts"],
      [0.94, "src/models/cart.ts"],
      [0.93, "src/models/status.ts"],
    ]);
    expect(dominantDirectoryShare(flatScattered)).toBe(1);
    expect(dominantBasenameTokenShare(flatScattered)).toBeLessThan(T.DOMINANT_TOKEN_SHARE);
  });
});

describe("MATCH_QUALITY_THRESHOLDS (#994 drift guard)", () => {
  it("documents the exact threshold constants", () => {
    expect(T.CLEAR_WINNER_SPREAD).toBe(0.15);
    expect(T.SCATTERED_SEED_COUNT).toBe(5);
    expect(T.DOMINANT_TOKEN_SHARE).toBe(0.5);
  });
});

describe("deriveMatchQuality back-compat wrapper (#961/#994)", () => {
  it("returns only the bare quality, matching deriveMatchQualityDetailed's quality field", () => {
    const s = seeds([[0.31, "a.ts"]]);
    expect(deriveMatchQuality(s)).toBe(deriveMatchQualityDetailed(s).quality);
    expect(deriveMatchQuality([])).toBe("weak");
  });
});
