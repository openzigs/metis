/**
 * #135 — the server-side model catalog (`GET /api/ai/models`). Every model
 * picker renders from this; `ui/src` keeps no model list of its own.
 */
import type { ModelCatalogEntry, ModelCatalogResponse } from "@metis/shared";
import { apiFetch } from "@/lib/api-client";

export type { ModelCatalogEntry, ModelCatalogResponse };

export const modelCatalogApi = {
  /**
   * The configured provider's models (`scope: "provider"`, the default), or the
   * models the analysis ModelRouter can select (`scope: "router"`).
   */
  list: (scope: "provider" | "router" = "provider") =>
    apiFetch<ModelCatalogResponse>(scope === "router" ? "/ai/models?scope=router" : "/ai/models"),
};

/** `$3 / $15 per MTok`-style label, or `null` when the model is unpriced. */
export function formatModelPrice(entry: Pick<ModelCatalogEntry, "price">): string | null {
  if (!entry.price) return null;
  const usd = (n: number) => `$${Number.isInteger(n) ? n : n.toFixed(2)}`;
  return `${usd(entry.price.inputPerMTok)} / ${usd(entry.price.outputPerMTok)} per MTok`;
}
