/**
 * #22 — an administrator's per-model price, written through the SAME
 * `ConfigService.set` the admin settings API (`PUT /api/admin/config/:key`)
 * uses, is what the next usage record is priced with. Guards the "write
 * reports success but the reader cannot see it" shape: the price is read back
 * through `resolveRate`, the function both usage tables call.
 */
import { describe, expect, it, vi } from "vitest";

const upsert = vi.fn(async (_: unknown) => ({}));
vi.mock("../prisma.js", () => ({
  prisma: { runtimeConfig: { upsert: (a: unknown) => upsert(a) } },
}));

import { ConfigService } from "../config/config-service.js";
import { ConfigValidationError } from "../config/errors.js";
import { computeCostCents, resolveRate } from "./provider-rates.js";

describe("MODEL_PRICES written through the admin config path (#22)", () => {
  it("prices the next usage row with the value the admin just saved", async () => {
    const config = new ConfigService({ env: {}, vault: {} as never });
    expect(resolveRate("anthropic", "deepseek-v4-pro", { config, env: {} })).toBeNull();

    // The admin settings textarea submits the JSON as a string.
    await config.set(
      "MODEL_PRICES",
      '{"deepseek-v4-pro": {"inputPerMTok": 1.32, "outputPerMTok": 3.96}}',
      { actorId: "admin-1" },
    );

    // Persisted to runtime_config as JSON…
    const stored = (upsert.mock.calls[0]?.[0] as { create: { key: string; value: string } }).create;
    expect(stored.key).toBe("MODEL_PRICES");
    expect(JSON.parse(stored.value)).toEqual({
      "deepseek-v4-pro": { inputPerMTok: 1.32, outputPerMTok: 3.96 },
    });
    // …and visible to the pricing read path immediately, without a restart.
    const rate = resolveRate("anthropic", "deepseek-v4-pro", { config, env: {} });
    expect(computeCostCents(rate, { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBe(528);
  });

  it("rejects an invalid price at the write, before it can reach accounting", async () => {
    const config = new ConfigService({ env: {}, vault: {} as never });
    await expect(
      config.set("MODEL_PRICES", '{"m": {"inputPerMTok": -1, "outputPerMTok": 1}}', {
        actorId: "admin-1",
      }),
    ).rejects.toBeInstanceOf(ConfigValidationError);
  });
});
