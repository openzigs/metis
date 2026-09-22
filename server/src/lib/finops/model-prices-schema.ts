/**
 * #22 — the `MODEL_PRICES` tunable's shape: an administrator's per-model
 * prices. Kept apart from `provider-rates.ts` (which reads the config service)
 * so the config key registry can import the schema without an import cycle.
 */
import { z } from "zod";

/** Registry key for the administrator's per-model price overrides. */
export const MODEL_PRICES_KEY = "MODEL_PRICES";

/**
 * One administrator-configured price, in USD per million tokens (the unit
 * every provider publishes). Cache prices are optional; an omitted one is
 * billed at the input price by {@link computeCostCents}.
 */
export const modelPriceSchema = z
  .object({
    inputPerMTok: z.number().finite().min(0).max(100_000),
    outputPerMTok: z.number().finite().min(0).max(100_000),
    cacheReadPerMTok: z.number().finite().min(0).max(100_000).optional(),
    cacheWritePerMTok: z.number().finite().min(0).max(100_000).optional(),
  })
  .strict();
export type ModelPrice = z.infer<typeof modelPriceSchema>;

/**
 * `MODEL_PRICES` value: a map from `model` or `provider:model` (the more
 * specific key wins) to a {@link ModelPrice}. Accepts the JSON string the
 * admin settings textarea submits, or an already-parsed object.
 */
export const modelPricesSchema = z
  .union([z.string(), z.record(z.string(), z.unknown())])
  .transform((raw, ctx) => {
    if (typeof raw !== "string") return raw;
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "MODEL_PRICES must be valid JSON" });
      return z.NEVER;
    }
  })
  .pipe(z.record(z.string().trim().min(1).max(300), modelPriceSchema));
