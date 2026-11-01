/**
 * Epic #1608 (#1626) — what to check and where: a requirement statement (or an
 * approved requirement handed over from its detail view), and one product or
 * every product the analyst can access.
 *
 * Validation mirrors `createPortfolioAssessmentSchema` (#1625): exactly one of
 * statement and requirement, a `product` scope names exactly one product, an
 * `all-accessible` one names none. The server checks it again, with access.
 */
"use client";

import { useState, type FormEvent } from "react";
import type { CreatePortfolioAssessmentInput, PortfolioAssessmentScope } from "@metis/shared";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

/** The statement's limit in `createPortfolioAssessmentSchema`. */
export const STATEMENT_MAX = 8_000;

export interface PortfolioFormProduct {
  id: string;
  name: string;
}

export interface PortfolioFormRequirement {
  id: string;
  title: string;
}

export function PortfolioAssessmentForm({
  products,
  productsLoading = false,
  initialProductId,
  requirement,
  onClearRequirement,
  pending,
  error,
  onSubmit,
}: {
  products: PortfolioFormProduct[];
  productsLoading?: boolean;
  initialProductId?: string | null;
  requirement?: PortfolioFormRequirement | null;
  onClearRequirement?: () => void;
  pending: boolean;
  error?: string | null;
  onSubmit: (input: CreatePortfolioAssessmentInput) => void;
}) {
  const [statement, setStatement] = useState("");
  const [scope, setScope] = useState<PortfolioAssessmentScope>(
    initialProductId ? "product" : "all-accessible",
  );
  const [productId, setProductId] = useState(initialProductId ?? "");

  const hasSource = requirement ? true : statement.trim().length > 0;
  const hasScope = scope === "all-accessible" || productId !== "";
  const canSubmit = hasSource && hasScope && !pending;

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    const source = requirement
      ? { requirementId: requirement.id }
      : { statement: statement.trim() };
    onSubmit(
      scope === "product"
        ? { ...source, scope, productIds: [productId] }
        : { ...source, scope: "all-accessible" },
    );
  }

  return (
    <form
      className="space-y-5 rounded-lg border border-border p-4"
      onSubmit={handleSubmit}
      aria-label="Check a requirement across your portfolio"
      data-testid="portfolio-assessment-form"
    >
      {requirement ? (
        <div className="space-y-1" data-testid="portfolio-form-requirement">
          <p className="text-sm font-medium">Requirement</p>
          <p className="text-sm">{requirement.title}</p>
          {onClearRequirement ? (
            <Button
              type="button"
              variant="link"
              size="sm"
              className="px-0"
              onClick={onClearRequirement}
            >
              Type a statement instead
            </Button>
          ) : null}
        </div>
      ) : (
        <div className="space-y-1">
          <Label htmlFor="portfolio-statement">Requirement statement</Label>
          <Textarea
            id="portfolio-statement"
            value={statement}
            maxLength={STATEMENT_MAX}
            rows={5}
            placeholder="For example: Customers can pay an invoice by bank transfer."
            aria-describedby="portfolio-statement-hint"
            onChange={(e) => setStatement(e.target.value)}
          />
          <p id="portfolio-statement-hint" className="text-xs text-muted-foreground">
            Describe what the business needs in plain language. Up to{" "}
            {STATEMENT_MAX.toLocaleString()} characters.
          </p>
        </div>
      )}

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Where to look</legend>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name="portfolio-scope"
            value="all-accessible"
            checked={scope === "all-accessible"}
            onChange={() => setScope("all-accessible")}
          />
          All products I can access
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name="portfolio-scope"
            value="product"
            checked={scope === "product"}
            onChange={() => setScope("product")}
          />
          One product
        </label>
        {scope === "product" ? (
          <div className="space-y-1 pl-6">
            <Label htmlFor="portfolio-product">Product</Label>
            <select
              id="portfolio-product"
              className="h-9 w-full max-w-sm rounded-md border border-input bg-background px-2 text-sm"
              value={productId}
              disabled={productsLoading}
              onChange={(e) => setProductId(e.target.value)}
            >
              <option value="">{productsLoading ? "Loading products…" : "Choose a product"}</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
        ) : null}
      </fieldset>

      {error ? (
        <p role="alert" className="text-sm text-destructive" data-testid="portfolio-form-error">
          {error}
        </p>
      ) : null}

      <Button type="submit" disabled={!canSubmit} data-testid="portfolio-form-submit">
        {pending ? "Starting…" : "Check coverage"}
      </Button>
    </form>
  );
}
