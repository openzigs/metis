/**
 * Epic #1608 (#1626) — what to check and where: a requirement statement (or an
 * approved requirement handed over from its detail view), and one product or
 * every product the analyst can access.
 *
 * Validation mirrors `createPortfolioAssessmentSchema` (#1625): exactly one of
 * statement and requirement, a `product` scope names exactly one product, an
 * `all-accessible` one names none. The server checks it again, with access.
 *
 * #1673 — the product list is one page of the analyst's products. With
 * `onProductQueryChange` the form offers a search, which the page sends to
 * `GET /products?search=`, and says when the list is not all of them. The
 * product chosen stays chosen while the list changes under it.
 *
 * #1680 — a product arrived with (`?productId=`) that is not on the first page
 * is named by `initialProductName`, which the page reads on its own.
 *
 * #1725 — an optional "Which product will build this?" picker sends
 * `hostProductId`. Where nothing covers the requirement yet, the impact walk
 * starts from that product; without one there is nothing to walk from. It
 * offers the products the analyst can read (the same list), and a `product`
 * scope may only host on its own product, as the schema says.
 *
 * #2272 — "Several products" checks the products ticked (up to
 * `PORTFOLIO_ASSESSMENT_MAX_PRODUCTS`), sent as a `product` scope naming each;
 * the host may be any one of them. A document handed over from the project's
 * documents (`document`) is sent by id: the server reads it and checks each
 * requirement it holds.
 */
"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  PORTFOLIO_ASSESSMENT_MAX_PRODUCTS,
  type CreatePortfolioAssessmentInput,
} from "@metis/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

/** #1725 — the host picker's id, the fragment a check that needs a host links to. */
const HOST_PICKER_ID = "portfolio-host";

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

/** #2272 — a document handed over to be checked, requirement by requirement. */
export interface PortfolioFormDocument {
  id: string;
  title: string;
}

/** Where to look: every product, one chosen product, or (#2272) several chosen ones. */
type ScopeMode = "all-accessible" | "product" | "several";

export function PortfolioAssessmentForm({
  products,
  productsLoading = false,
  initialProductId,
  initialProductName,
  initialProductIds,
  initialStatement = "",
  requirement,
  onClearRequirement,
  document,
  onClearDocument,
  productQuery = "",
  onProductQueryChange,
  productTotal,
  pending,
  error,
  onSubmit,
}: {
  products: PortfolioFormProduct[];
  productsLoading?: boolean;
  /** #1673 — the product search typed so far; the page filters `products` by it. */
  productQuery?: string;
  onProductQueryChange?: (query: string) => void;
  /** How many products match in all, when `products` may be only the first page. */
  productTotal?: number;
  initialProductId?: string | null;
  /** #1680 — the name of `initialProductId`, for when the list does not hold it. */
  initialProductName?: string | null;
  /** #2272 — several products to start chosen (a check of several re-run to choose a host). */
  initialProductIds?: string[];
  /** #1725 — a statement to start from (a check re-run to choose a host). */
  initialStatement?: string;
  requirement?: PortfolioFormRequirement | null;
  onClearRequirement?: () => void;
  /** #2272 — a document whose requirements are each checked. */
  document?: PortfolioFormDocument | null;
  onClearDocument?: () => void;
  pending: boolean;
  error?: string | null;
  onSubmit: (input: CreatePortfolioAssessmentInput) => void;
}) {
  const [statement, setStatement] = useState(initialStatement.slice(0, STATEMENT_MAX));
  const several0 = (initialProductIds ?? []).length > 1;
  const [scope, setScope] = useState<ScopeMode>(
    several0 ? "several" : initialProductId ? "product" : "all-accessible",
  );
  // #2272 — the products ticked for "Several products", and the names of those the list may drop.
  const [chosen, setChosen] = useState<string[]>(several0 ? (initialProductIds ?? []) : []);
  const [chosenNames, setChosenNames] = useState<Record<string, string>>({});
  const [productId, setProductId] = useState(initialProductId ?? "");
  // The chosen product's name, kept while a search narrows the list past it.
  // #1689 — read from the list whenever it holds the product, so one the page
  // arrived with keeps its name too, not only one picked here.
  const [chosenName, setChosenName] = useState<string | null>(null);
  const listedName = products.find((p) => p.id === productId)?.name;
  if (listedName !== undefined && listedName !== chosenName) setChosenName(listedName);
  const options =
    productId && !products.some((p) => p.id === productId)
      ? [
          {
            id: productId,
            name:
              chosenName ??
              (productId === initialProductId ? initialProductName : null) ??
              "Selected product",
          },
          ...products,
        ]
      : products;

  // #1725 — the host picked, and its name, kept while a search narrows the list past it.
  const [hostId, setHostId] = useState("");
  const [hostName, setHostName] = useState<string | null>(null);
  const listedHostName = products.find((p) => p.id === hostId)?.name;
  if (listedHostName !== undefined && listedHostName !== hostName) setHostName(listedHostName);
  // #2272 — every product ticked, named from the list or as it was when ticked.
  const nameOfChosen = (id: string) =>
    products.find((p) => p.id === id)?.name ?? chosenNames[id] ?? "Selected product";
  const severalOptions = [
    ...chosen
      .filter((id) => !products.some((p) => p.id === id))
      .map((id) => ({ id, name: nameOfChosen(id) })),
    ...products,
  ];
  const full = chosen.length >= PORTFOLIO_ASSESSMENT_MAX_PRODUCTS;
  const toggle = (p: PortfolioFormProduct) => {
    setChosenNames((cur) => ({ ...cur, [p.id]: p.name }));
    setChosen((cur) => (cur.includes(p.id) ? cur.filter((id) => id !== p.id) : [...cur, p.id]));
  };

  // A `product` scope hosts only on its own products (`createPortfolioAssessmentSchema`).
  const hostOptions =
    scope === "product"
      ? options.filter((p) => p.id === productId)
      : scope === "several"
        ? chosen.map((id) => ({ id, name: nameOfChosen(id) }))
        : hostId && !options.some((p) => p.id === hostId)
          ? [{ id: hostId, name: hostName ?? "Selected product" }, ...options]
          : options;
  const host = hostOptions.some((p) => p.id === hostId) ? hostId : "";

  // #1749 — a check that needed a host links here at `#portfolio-host`: put the
  // focus on the picker, not only the scroll, once the list it waits on is in.
  const hostRef = useRef<HTMLSelectElement>(null);
  const hostFocused = useRef(false);
  useEffect(() => {
    if (hostFocused.current || productsLoading) return;
    if (window.location.hash !== `#${HOST_PICKER_ID}`) return;
    hostFocused.current = true;
    hostRef.current?.focus();
  }, [productsLoading]);

  const hasSource = requirement || document ? true : statement.trim().length > 0;
  const hasScope =
    scope === "all-accessible" ||
    (scope === "product" && productId !== "") ||
    (scope === "several" && chosen.length > 0);
  const canSubmit = hasSource && hasScope && !pending;

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    const source = document
      ? { documentId: document.id }
      : requirement
        ? { requirementId: requirement.id }
        : { statement: statement.trim() };
    const hosted = host ? { hostProductId: host } : {};
    onSubmit(
      scope === "product"
        ? { ...source, scope, productIds: [productId], ...hosted }
        : scope === "several"
          ? { ...source, scope: "product", productIds: chosen, ...hosted }
          : { ...source, scope: "all-accessible", ...hosted },
    );
  }

  return (
    <form
      className="space-y-5 rounded-lg border border-border p-4"
      onSubmit={handleSubmit}
      aria-label="Check a requirement across your portfolio"
      data-testid="portfolio-assessment-form"
    >
      {document ? (
        <div className="space-y-1" data-testid="portfolio-form-document">
          <p className="text-sm font-medium">Document</p>
          <p className="text-sm">{document.title}</p>
          <p className="text-xs text-muted-foreground">
            METIS reads the document and checks each requirement it finds on its own. Anything it
            cannot check is listed as not checked.
          </p>
          {onClearDocument ? (
            <Button
              type="button"
              variant="link"
              size="sm"
              className="px-0"
              onClick={onClearDocument}
            >
              Type a statement instead
            </Button>
          ) : null}
        </div>
      ) : requirement ? (
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
        <label className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name="portfolio-scope"
            value="several"
            checked={scope === "several"}
            onChange={() => setScope("several")}
          />
          Several products
        </label>
        {scope === "several" ? (
          <div className="space-y-1 pl-6" data-testid="portfolio-several-products">
            {onProductQueryChange ? (
              <div className="space-y-1 pb-1">
                <Label htmlFor="portfolio-several-search">Find products</Label>
                <Input
                  id="portfolio-several-search"
                  type="search"
                  className="max-w-sm"
                  value={productQuery}
                  placeholder="Type part of a product's name"
                  onChange={(e) => onProductQueryChange(e.target.value)}
                />
              </div>
            ) : null}
            <fieldset className="space-y-1" aria-describedby="portfolio-several-hint">
              <legend className="text-sm font-medium">Products to check</legend>
              {productsLoading ? (
                <p className="text-sm text-muted-foreground">Loading products…</p>
              ) : (
                severalOptions.map((p) => {
                  const checked = chosen.includes(p.id);
                  return (
                    <label key={p.id} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={!checked && full}
                        onChange={() => toggle(p)}
                      />
                      {p.name}
                    </label>
                  );
                })
              )}
            </fieldset>
            <p id="portfolio-several-hint" className="text-xs text-muted-foreground">
              {chosen.length} chosen, up to {PORTFOLIO_ASSESSMENT_MAX_PRODUCTS}.
              {productTotal !== undefined && productTotal > products.length
                ? ` Showing ${products.length} of ${productTotal} products${onProductQueryChange ? "; type part of a name to find another" : ""}.`
                : ""}
            </p>
          </div>
        ) : null}
        {scope === "product" ? (
          <div className="space-y-1 pl-6">
            {onProductQueryChange ? (
              <div className="space-y-1 pb-1">
                <Label htmlFor="portfolio-product-search">Find a product</Label>
                <Input
                  id="portfolio-product-search"
                  type="search"
                  className="max-w-sm"
                  value={productQuery}
                  placeholder="Type part of a product's name"
                  onChange={(e) => onProductQueryChange(e.target.value)}
                />
              </div>
            ) : null}
            <Label htmlFor="portfolio-product">Product</Label>
            <select
              id="portfolio-product"
              className="h-9 w-full max-w-sm rounded-md border border-input bg-background px-2 text-sm"
              value={productId}
              disabled={productsLoading}
              aria-describedby={
                productTotal !== undefined && productTotal > products.length
                  ? "portfolio-product-more"
                  : undefined
              }
              onChange={(e) => {
                setProductId(e.target.value);
                setChosenName(null);
              }}
            >
              <option value="">{productsLoading ? "Loading products…" : "Choose a product"}</option>
              {options.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            {productTotal !== undefined && productTotal > products.length ? (
              <p id="portfolio-product-more" className="text-xs text-muted-foreground">
                Showing {products.length} of {productTotal} products.
                {onProductQueryChange ? " Type part of a name to find another." : ""}
              </p>
            ) : null}
          </div>
        ) : null}
      </fieldset>

      <div className="space-y-1">
        {scope === "all-accessible" && onProductQueryChange ? (
          <div className="space-y-1 pb-1">
            <Label htmlFor="portfolio-host-search">Find a product to build it</Label>
            <Input
              id="portfolio-host-search"
              type="search"
              className="max-w-sm"
              value={productQuery}
              placeholder="Type part of a product's name"
              onChange={(e) => onProductQueryChange(e.target.value)}
            />
          </div>
        ) : null}
        <Label htmlFor={HOST_PICKER_ID}>Which product will build this? (optional)</Label>
        <select
          ref={hostRef}
          id={HOST_PICKER_ID}
          className="h-9 w-full max-w-sm rounded-md border border-input bg-background px-2 text-sm"
          value={host}
          disabled={productsLoading}
          aria-describedby="portfolio-host-hint"
          onChange={(e) => {
            setHostId(e.target.value);
            setHostName(null);
          }}
          data-testid="portfolio-host-select"
        >
          <option value="">Not decided yet</option>
          {hostOptions.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <p id="portfolio-host-hint" className="text-xs text-muted-foreground">
          If no product does this yet, choose the one that will build it to see which other products
          the change reaches.
        </p>
      </div>

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
