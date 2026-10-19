/**
 * #1209 — the per-run breaker that stops retrying dropped connections.
 * The synthesis loop that uses it is covered in
 * `holistic-synthesizer-midstream-retry.test.ts`.
 */
import { describe, expect, it } from "vitest";
import type { ConfigService } from "../config/config-service.js";
import {
  DEFAULT_DROP_RETRY_SECTION_LIMIT,
  DROP_RETRY_SECTION_LIMIT_KEY,
  DropRetryBreaker,
  currentDropRetryBreaker,
  resolveDropRetrySectionLimit,
  withDropRetryBreaker,
} from "./drop-retry-breaker.js";

const config = (value: number | undefined): ConfigService =>
  ({
    getNumber: (key: string, d?: number) =>
      key === DROP_RETRY_SECTION_LIMIT_KEY && value !== undefined ? value : d,
  }) as unknown as ConfigService;

describe("resolveDropRetrySectionLimit", () => {
  it("defaults to 2", () => {
    expect(DEFAULT_DROP_RETRY_SECTION_LIMIT).toBe(2);
    expect(resolveDropRetrySectionLimit(config(undefined))).toBe(2);
  });

  it("reads the key, keeps 0, and falls back for a negative or non-numeric value", () => {
    expect(resolveDropRetrySectionLimit(config(5))).toBe(5);
    expect(resolveDropRetrySectionLimit(config(0))).toBe(0);
    expect(resolveDropRetrySectionLimit(config(-1))).toBe(2);
    expect(resolveDropRetrySectionLimit(config(Number.NaN))).toBe(2);
  });
});

describe("DropRetryBreaker", () => {
  it("trips at its limit and records why", () => {
    const b = new DropRetryBreaker(2);
    b.noteExhausted("overview");
    expect(b.tripped).toBe(false);
    expect(b.record()).toBeUndefined();
    b.noteExhausted("rules");
    expect(b.tripped).toBe(true);
    expect(b.record()).toEqual({
      reason: "repeated-connection-drops",
      limit: 2,
      exhaustedSections: 2,
    });
  });

  it("counts sections, not drafts: two dropped batches of one section are one section", () => {
    const b = new DropRetryBreaker(2);
    b.noteExhausted("rules");
    b.noteExhausted("rules");
    expect(b.tripped).toBe(false);
  });

  it("never trips at 0", () => {
    const b = new DropRetryBreaker(0);
    for (let i = 0; i < 5; i++) b.noteExhausted(`s${i}`);
    expect(b.tripped).toBe(false);
  });

  it("is found only inside its run", async () => {
    const b = new DropRetryBreaker();
    expect(currentDropRetryBreaker()).toBeUndefined();
    await withDropRetryBreaker(b, async () => {
      await Promise.resolve();
      expect(currentDropRetryBreaker()).toBe(b);
    });
    expect(currentDropRetryBreaker()).toBeUndefined();
  });
});
