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

/**
 * `$3 / $15 per MTok`-style label, or `null` when the model is unpriced. A
 * model priced by prompt length (#1080) also names its long-prompt prices:
 * `$0.10 / $0.50 per MTok; $0.50 / $2.50 for prompts over 100,000 tokens`.
 */
export function formatModelPrice(entry: Pick<ModelCatalogEntry, "price">): string | null {
  if (!entry.price) return null;
  const usd = (n: number) => `$${Number.isInteger(n) ? n : n.toFixed(2)}`;
  const base = `${usd(entry.price.inputPerMTok)} / ${usd(entry.price.outputPerMTok)} per MTok`;
  const long = entry.price.longPrompt;
  if (!long) return base;
  return `${base}; ${usd(long.inputPerMTok)} / ${usd(long.outputPerMTok)} for prompts over ${long.overPromptTokens.toLocaleString("en-US")} tokens`;
}
