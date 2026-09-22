/**
 * #42 — every built-in Claude price is pinned to the price its vendor publishes.
 *
 * Before #42 `bedrock-gateway:us.anthropic.claude-fable-5` was billed at the
 * Haiku 4.5 rate ($1/$5), about a tenth of its real price, and nothing noticed:
 * the existing tests only asserted that a rate was non-zero. This file states,
 * for EVERY `claude` row in the table and for the family match that prices ids
 * the table does not list, the exact published price in USD per MTok. A row
 * added without a published price, or a price edited away from the published
 * one, fails here.
 *
 * Sources (read 2026-09-22):
 *  - Anthropic (the `anthropic` provider): the model pricing table at
 *    https://platform.claude.com/docs/en/about-claude/pricing
 *  - Amazon Bedrock (the `bedrock-gateway` provider): the AWS Price List API,
 *    offer `AmazonBedrockFoundationModels`, region us-east-1, publication
 *    2026-09-11 (https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/
 *    AmazonBedrockFoundationModels/current/us-east-1/index.json), which is the
 *    machine-readable form of https://aws.amazon.com/bedrock/pricing/.
 *    Bedrock bills a `us.`/`eu.`/… geo inference profile (and an in-region
 *    call) at the "Regional" SKU, which for Claude 4.5 and later models is 1.1x
 *    the "Global" SKU. Anthropic's pricing page says the same: "Regional and
 *    multi-region endpoints include a 10% premium over global endpoints", from
 *    Sonnet 4.5 / Haiku 4.5 / Opus 4.5 on. Earlier models have one price.
 */
import { describe, expect, it } from "vitest";

import { ConfigService } from "../config/config-service.js";
import { __testRateKeys, claudeFamilyRate, resolveRate, type TokenRate } from "./provider-rates.js";

/** USD per MTok, as the vendors publish it. */
interface Published {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

const config = new ConfigService({ env: {}, vault: {} as never });

/** Published USD/MTok → the table's cents per 1k tokens. */
function toCentsPer1k(p: Published): TokenRate {
  const c = (usd: number) => usd / 10;
  return {
    inputPer1k: c(p.input),
    outputPer1k: c(p.output),
    ...(p.cacheRead !== undefined ? { cacheReadPer1k: c(p.cacheRead) } : {}),
    ...(p.cacheWrite !== undefined ? { cacheWritePer1k: c(p.cacheWrite) } : {}),
  };
}

function expectRate(actual: TokenRate | null | undefined, published: Published): void {
  expect(actual).toBeTruthy();
  const want = toCentsPer1k(published);
  expect(actual!.inputPer1k).toBeCloseTo(want.inputPer1k, 10);
  expect(actual!.outputPer1k).toBeCloseTo(want.outputPer1k, 10);
  if (want.cacheReadPer1k === undefined) expect(actual!.cacheReadPer1k).toBeUndefined();
  else expect(actual!.cacheReadPer1k).toBeCloseTo(want.cacheReadPer1k, 10);
  if (want.cacheWritePer1k === undefined) expect(actual!.cacheWritePer1k).toBeUndefined();
  else expect(actual!.cacheWritePer1k).toBeCloseTo(want.cacheWritePer1k, 10);
}

// ── Anthropic pricing page ────────────────────────────────────────────────
const A_SONNET_4: Published = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
const A_OPUS_45: Published = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 };
const A_HAIKU_45: Published = { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 };
const A_HAIKU_35: Published = { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 };
const A_SONNET_5: Published = { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 };
const A_OPUS_41: Published = { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 };
const A_FABLE_5: Published = { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 };
const A_FABLE_51: Published = { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 };

// ── AWS Price List, us-east-1, Regional ("Standard" / "Regional CRIS") SKU ─
const B_SONNET_46_REGIONAL: Published = {
  input: 3.3,
  output: 16.5,
  cacheRead: 0.33,
  cacheWrite: 4.125,
};
const B_SONNET_5_REGIONAL: Published = {
  input: 2.2,
  output: 11,
  cacheRead: 0.22,
  cacheWrite: 2.75,
};
const B_OPUS_48_REGIONAL: Published = {
  input: 5.5,
  output: 27.5,
  cacheRead: 0.55,
  cacheWrite: 6.875,
};
const B_FABLE_5_REGIONAL: Published = {
  input: 11,
  output: 55,
  cacheRead: 1.1,
  cacheWrite: 13.75,
};
const B_HAIKU_45_REGIONAL: Published = {
  input: 1.1,
  output: 5.5,
  cacheRead: 0.11,
  cacheWrite: 1.375,
};
const B_SONNET_35_V2: Published = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
const B_SONNET_35_V1: Published = { input: 3, output: 15 };
const B_HAIKU_35: Published = { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 };
const B_HAIKU_3: Published = { input: 0.25, output: 1.25 };
const B_OPUS_3: Published = { input: 15, output: 75 };

/** Every built-in Claude row → its published price. */
const PINNED: Record<string, Published> = {
  "anthropic:claude-sonnet-4-6": A_SONNET_4,
  "anthropic:claude-sonnet-4-5": A_SONNET_4,
  "anthropic:claude-sonnet-4": A_SONNET_4,
  "anthropic:claude-opus-4-8": A_OPUS_45,
  "anthropic:claude-opus-4-6": A_OPUS_45,
  "anthropic:claude-opus-4-5": A_OPUS_45,
  "anthropic:claude-haiku-4-5": A_HAIKU_45,
  "anthropic:claude-3-5-haiku": A_HAIKU_35,
  "bedrock-gateway:us.anthropic.claude-sonnet-4-6": B_SONNET_46_REGIONAL,
  "bedrock-gateway:anthropic.claude-sonnet-4-6": B_SONNET_46_REGIONAL,
  "bedrock-gateway:us.anthropic.claude-sonnet-5": B_SONNET_5_REGIONAL,
  "bedrock-gateway:us.anthropic.claude-opus-4-8": B_OPUS_48_REGIONAL,
  "bedrock-gateway:us.anthropic.claude-fable-5": B_FABLE_5_REGIONAL,
  "bedrock-gateway:anthropic.claude-3-5-sonnet-20241022-v2:0": B_SONNET_35_V2,
  "bedrock-gateway:anthropic.claude-3-5-sonnet-20240620-v1:0": B_SONNET_35_V1,
  "bedrock-gateway:anthropic.claude-3-5-haiku-20241022-v1:0": B_HAIKU_35,
  "bedrock-gateway:anthropic.claude-3-opus-20240229-v1:0": B_OPUS_3,
};

/**
 * Rows for models Anthropic has retired from its API and no longer lists a
 * price for. They are kept because historical usage rows name them; each is
 * held at the last list price, which is also what the family match gives.
 */
const RETIRED_UNLISTED: Record<string, Published> = {
  "anthropic:claude-3-5-sonnet-20241022": A_SONNET_4,
  "anthropic:claude-3-5-sonnet": { input: 3, output: 15 },
  "anthropic:claude-3-opus": { input: 15, output: 75 },
};

function split(key: string): [string, string] {
  const i = key.indexOf(":");
  return [key.slice(0, i), key.slice(i + 1)];
}

describe("published Claude prices — every built-in row (#42)", () => {
  it("accounts for every claude row in the table, and no row that is not there", () => {
    // Identity, not just content: a new Claude row with no pinned price fails
    // here, and so does a pinned row that was deleted from the table.
    const claudeKeys = __testRateKeys().filter((k) => k.includes("claude"));
    expect(claudeKeys.sort()).toEqual(
      [...Object.keys(PINNED), ...Object.keys(RETIRED_UNLISTED)].sort(),
    );
  });

  it.each(Object.entries(PINNED))("%s is at its published price", (key, published) => {
    const [provider, model] = split(key);
    expectRate(resolveRate(provider, model, { config, env: {} }), published);
  });

  it.each(Object.entries(RETIRED_UNLISTED))(
    "%s (retired, unlisted) is at its last list price",
    (key, published) => {
      const [provider, model] = split(key);
      expectRate(resolveRate(provider, model, { config, env: {} }), published);
    },
  );

  it("prices Bedrock Claude Fable 5 at Bedrock's Fable price, not Haiku's (#42)", () => {
    const rate = resolveRate("bedrock-gateway", "us.anthropic.claude-fable-5", {
      config,
      env: {},
    });
    // 1M in + 1M out at the us-east-1 Regional SKU: $11 + $55 = $66.
    expect(rate!.inputPer1k * 1000 + rate!.outputPer1k * 1000).toBeCloseTo(6600, 6);
  });
});

describe("published Claude prices — the family match (#42)", () => {
  // Ids the table does not list, priced by `claudeFamilyRate`. Each is a real
  // id shape: bare first-party, dated first-party, Bedrock geo profile,
  // Bedrock global profile.
  const cases: Array<[string, Published]> = [
    ["claude-fable-5", A_FABLE_5],
    ["claude-fable-5-1", A_FABLE_51],
    ["claude-opus-5", A_OPUS_45],
    ["claude-opus-4-7", A_OPUS_45],
    ["claude-opus-4-1-20250805", A_OPUS_41],
    ["claude-opus-4-20250514", A_OPUS_41],
    ["claude-sonnet-5", A_SONNET_5],
    ["claude-sonnet-4-5-20250929", A_SONNET_4],
    ["claude-sonnet-4-20250514", A_SONNET_4],
    ["claude-haiku-4-5-20251001", A_HAIKU_45],
    ["claude-3-5-haiku-20241022", A_HAIKU_35],
    ["claude-3-haiku-20240307", B_HAIKU_3],
    // Bedrock geo profiles of Claude 4.5+ models bill at the Regional SKU.
    ["us.anthropic.claude-haiku-4-5-20251001-v1:0", B_HAIKU_45_REGIONAL],
    ["eu.anthropic.claude-sonnet-4-6", B_SONNET_46_REGIONAL],
    ["us.anthropic.claude-fable-5-v1:0", B_FABLE_5_REGIONAL],
    ["apac.anthropic.claude-opus-4-8-v1:0", B_OPUS_48_REGIONAL],
    // A system inference-profile ARN names its profile id after the last `/`.
    [
      "arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-sonnet-5",
      B_SONNET_5_REGIONAL,
    ],
    // ...and Global profiles at the Global SKU, which equals the Anthropic price.
    ["global.anthropic.claude-haiku-4-5-20251001-v1:0", A_HAIKU_45],
    ["global.anthropic.claude-fable-5", A_FABLE_5],
    // Models before 4.5 have a single Bedrock price, prefix or not.
    ["us.anthropic.claude-sonnet-4-20250514-v1:0", A_SONNET_4],
    ["us.anthropic.claude-3-5-haiku-20241022-v1:0", B_HAIKU_35],
    ["us.anthropic.claude-opus-4-1-20250805-v1:0", A_OPUS_41],
  ];

  it.each(cases)("%s is at its published price", (model, published) => {
    expectRate(claudeFamilyRate(model), published);
  });

  it("the default Bedrock judge model is priced at the Regional Haiku 4.5 SKU", () => {
    // HAIKU_MODEL_ID (model-router.ts) — the test-coverage judge's model.
    expectRate(
      resolveRate("bedrock-gateway", "us.anthropic.claude-haiku-4-5-20251001-v1:0", {
        config,
        env: {},
      }),
      B_HAIKU_45_REGIONAL,
    );
  });
});
