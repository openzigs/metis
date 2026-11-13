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
import { ScopePicker, type ScopeKind } from "@/components/scope/scope-picker";

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

/** #2345 — a change request handed over: each of its draft and approved requirements is checked. */
export interface PortfolioFormChangeRequest {
  id: string;
  title: string;
}

/** #2351 — the shared picker's "Whole workspace": the workspace's products the analyst can read. */
export interface PortfolioFormWorkspace {
  id: string;
  name: string;
  /** Its products the analyst can read (the first page of them). */
  productIds: string[];
  /** How many it has in all; more than a check takes is said, not cut. */
  count: number;
}

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
  changeRequest,
  onClearChangeRequest,
  productQuery = "",
  onProductQueryChange,
  productTotal,
  current,
  currentNote,
  workspace,
  workspaceNote,
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
  /** #2345 — a change request whose draft and approved requirements are each checked. */
  changeRequest?: PortfolioFormChangeRequest | null;
  onClearChangeRequest?: () => void;
  /** #2351 — "This project": the product of the project it was opened from. */
  current?: PortfolioFormProduct | null;
  /** Why there is no "This project" (e.g. the project is in no product). */
  currentNote?: string;
  /** #2351 — "Whole workspace": the top bar's workspace and its products. */
  workspace?: PortfolioFormWorkspace | null;
  workspaceNote?: string;
  pending: boolean;
  error?: string | null;
  onSubmit: (input: CreatePortfolioAssessmentInput) => void;
}) {
  const [statement, setStatement] = useState(initialStatement.slice(0, STATEMENT_MAX));
  // #2351 — the shared scope picker: "This project" (its product), "Chosen
  // products" (ticked) or "Whole workspace". Arriving with products ticks them;
  // otherwise it starts on this project's product, else the whole workspace,
  // until the analyst picks.
  const arrivedWith =
    (initialProductIds ?? []).length > 1
      ? (initialProductIds ?? [])
      : initialProductId
        ? [initialProductId]
        : [];
  const [picked, setPicked] = useState<ScopeKind | null>(arrivedWith.length > 0 ? "chosen" : null);
  // With no workspace open (none, or a workspace-less install), "Whole workspace"
  // is every product the analyst can read: the `all-accessible` scope, as before.
  const ws: PortfolioFormWorkspace & { all?: boolean } = workspace ?? {
    id: "",
    name: "every product you can read",
    productIds: [],
    count: productTotal ?? products.length,
    all: true,
  };
  const kind: ScopeKind | null = picked ?? (current ? "this" : "workspace");
  // #2272 — the products ticked, and the names of those the list may drop.
  const [chosen, setChosen] = useState<string[]>(arrivedWith);
  const [chosenNames, setChosenNames] = useState<Record<string, string>>({});
  // #1689 — a ticked product keeps the name the list gave it once a search drops it.
  const unnamed = chosen.find((id) => {
    const listed = products.find((p) => p.id === id)?.name;
    return listed !== undefined && chosenNames[id] !== listed;
  });
  if (unnamed !== undefined) {
    const listed = products.find((p) => p.id === unnamed)!.name;
    setChosenNames((cur) => ({ ...cur, [unnamed]: listed }));
  }
  // #1680 — a product arrived with that is past the first page is named by the page.
  const nameOf = (id: string) =>
    products.find((p) => p.id === id)?.name ??
    chosenNames[id] ??
    (id === current?.id ? current.name : null) ??
    (id === initialProductId ? initialProductName : null) ??
    "Selected product";
  const toggle = (p: PortfolioFormProduct) => {
    setChosenNames((cur) => ({ ...cur, [p.id]: p.name }));
    setChosen((cur) => {
      const base = kind === "chosen" ? cur : [];
      return base.includes(p.id) ? base.filter((id) => id !== p.id) : [...base, p.id];
    });
    setPicked("chosen");
  };
  const allAccessible = kind === "workspace" && ws.all === true;
  const workspaceTooBig = !ws.all && ws.count > PORTFOLIO_ASSESSMENT_MAX_PRODUCTS;
  // The products the check is scoped to; the server checks each one again.
  const scopeIds =
    kind === "this" && current
      ? [current.id]
      : kind === "chosen"
        ? chosen
        : kind === "workspace" && !ws.all && !workspaceTooBig
          ? ws.productIds
          : [];

  // #1725 — the host picked. A `product` scope hosts only on its own products
  // (`createPortfolioAssessmentSchema`), so it is one of the products in scope.
  // Across every product, any product the analyst can read may build it.
  const [hostId, setHostId] = useState("");
  const [hostName, setHostName] = useState<string | null>(null);
  const listedHostName = products.find((p) => p.id === hostId)?.name;
  if (listedHostName !== undefined && listedHostName !== hostName) setHostName(listedHostName);
  const hostOptions = allAccessible
    ? hostId && !products.some((p) => p.id === hostId)
      ? [{ id: hostId, name: hostName ?? "Selected product" }, ...products]
      : products
    : scopeIds.map((id) => ({ id, name: nameOf(id) }));
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

  const hasSource = changeRequest || requirement || document ? true : statement.trim().length > 0;
  const hasScope = allAccessible || scopeIds.length > 0;
  const canSubmit = hasSource && hasScope && !pending;

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    const source = changeRequest
      ? { analysisId: changeRequest.id }
      : document
        ? { documentId: document.id }
        : requirement
          ? { requirementId: requirement.id }
          : { statement: statement.trim() };
    const hosted = host ? { hostProductId: host } : {};
    onSubmit(
      allAccessible
        ? { ...source, scope: "all-accessible", ...hosted }
        : { ...source, scope: "product", productIds: scopeIds, ...hosted },
    );
  }

  return (
    <form
      className="space-y-5 rounded-lg border border-border p-4"
      onSubmit={handleSubmit}
      aria-label="Check a requirement across your portfolio"
      data-testid="portfolio-assessment-form"
    >
      {changeRequest ? (
        <div className="space-y-1" data-testid="portfolio-form-change-request">
          <p className="text-sm font-medium">Change request</p>
          <p className="text-sm">{changeRequest.title}</p>
          <p className="text-xs text-muted-foreground">
            METIS reads its draft and approved requirements and checks each on its own. Checked
            before they are approved, the result is labelled as run on unapproved requirements.
          </p>
          {onClearChangeRequest ? (
            <Button
              type="button"
              variant="link"
              size="sm"
              className="px-0"
              onClick={onClearChangeRequest}
            >
              Type a statement instead
            </Button>
          ) : null}
        </div>
      ) : document ? (
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

      <div className="space-y-1" data-testid="portfolio-scope">
        <p className="text-sm font-medium">Where to look</p>
        {onProductQueryChange ? (
          <div className="space-y-1 pb-1">
            <Label htmlFor="portfolio-product-search">Find products</Label>
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
        <ScopePicker
          kind={kind}
          chosenIds={chosen}
          items={[
            ...chosen
              .filter((id) => !products.some((p) => p.id === id))
              .map((id) => ({ id, name: nameOf(id) })),
            ...products,
          ]}
          itemsLoading={productsLoading}
          current={current ?? null}
          currentNote={
            currentNote ?? "Open this from a change request to check its project's product."
          }
          workspace={{ id: ws.id, name: ws.name, count: ws.count }}
          workspaceNote={workspaceNote ?? "No workspace is open in the top bar."}
          onPickThis={() => setPicked("this")}
          onPickWorkspace={() => setPicked("workspace")}
          onToggle={toggle}
          maxChosen={PORTFOLIO_ASSESSMENT_MAX_PRODUCTS}
          testIdBase="portfolio-scope"
          ariaLabel="Products to check"
        />
        <p className="text-xs text-muted-foreground" data-testid="portfolio-scope-hint">
          {kind === "workspace" && workspaceTooBig
            ? `The workspace has more than ${PORTFOLIO_ASSESSMENT_MAX_PRODUCTS} products: choose up to ${PORTFOLIO_ASSESSMENT_MAX_PRODUCTS}.`
            : allAccessible
              ? "Every product you can read is checked."
              : `${scopeIds.length} product${scopeIds.length === 1 ? "" : "s"} to check.`}
          {productTotal !== undefined && productTotal > products.length
            ? ` Showing ${products.length} of ${productTotal} products${onProductQueryChange ? "; type part of a name to find another" : ""}.`
            : ""}
        </p>
      </div>

      <div className="space-y-1">
        {allAccessible && onProductQueryChange ? (
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
