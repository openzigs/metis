/**
 * Epic #1608 (#1627) — the cross-product impact: every product the requirement
 * reaches, whether it must change or consumes what changes, through what and
 * how severely, with the stored severity derivation and a technical deep dive
 * one click away. Products it does not reach are listed in a collapsed group,
 * never left out.
 */
"use client";

import { useId, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  IMPACT_LABEL,
  viaLabel,
  type AffectedProduct,
  type NotAffectedProduct,
} from "@/lib/portfolio-impact";
import { PortfolioPathDiagram } from "./portfolio-path-diagram";

const SEVERITY_VARIANT: Record<string, "destructive" | "warning" | "info"> = {
  critical: "destructive",
  high: "destructive",
  medium: "warning",
  low: "info",
};

export function SeverityBadge({ severity }: { severity: string }) {
  return (
    <Badge variant={SEVERITY_VARIANT[severity] ?? "info"} data-testid="portfolio-severity">
      Severity: {severity}
    </Badge>
  );
}

/** A button that shows and hides the region it controls. */
function Disclosure({
  label,
  children,
  testId,
}: {
  label: string;
  children: ReactNode;
  testId: string;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="px-1"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
      >
        {open ? (
          <ChevronDown className="h-4 w-4" aria-hidden />
        ) : (
          <ChevronRight className="h-4 w-4" aria-hidden />
        )}
        {label}
      </Button>
      {open ? (
        <div id={id} className="mt-2 space-y-3 pl-6 text-sm" data-testid={testId}>
          {children}
        </div>
      ) : null}
    </div>
  );
}

function List({ title, items }: { title: string; items: ReactNode[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <h4 className="text-xs font-semibold uppercase text-muted-foreground">{title}</h4>
      <ul className="mt-1 space-y-0.5">
        {items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

function Mono({ children }: { children: ReactNode }) {
  return <code className="font-mono text-xs">{children}</code>;
}

function SeverityWhy({ product }: { product: AffectedProduct }) {
  return (
    <Disclosure label="Why this severity?" testId="portfolio-severity-why">
      <ol className="list-decimal space-y-1 pl-4">
        {product.derivation.map((d, i) => (
          <li key={i}>
            {d.label}: {d.strength} coupling starts at {d.base}
            {d.modifiers.length > 0 ? `; ${d.modifiers.join("; ")}` : ""}, so {d.severity}.
            Confidence {d.confidence}.
          </li>
        ))}
      </ol>
      <p>
        Overall: <strong>{product.severity}</strong>. A path is as severe as its weakest hop.
      </p>
    </Disclosure>
  );
}

function DeepDive({ product }: { product: AffectedProduct }) {
  const d = product.deepDive;
  return (
    <Disclosure label="Technical deep dive" testId="portfolio-deep-dive">
      <List
        title="Repositories"
        items={d.repos.map((r) => (
          <>
            <Mono>{r.label}</Mono> ({r.role})
          </>
        ))}
      />
      <List
        title="Files"
        items={d.files.map((f) => (
          <>
            {f.repo} · <Mono>{f.location}</Mono>
            {f.callSite ? " (call site)" : ""}
          </>
        ))}
      />
      {d.contract ? (
        <List
          title={`Contract items (version ${d.contract.version})`}
          items={d.contract.items.map((c) => (
            <>
              <Mono>{c.id}</Mono>: {c.change}
              {c.breaking ? ", breaking" : ""}
            </>
          ))}
        />
      ) : null}
      {d.resources.map((group) => (
        <List
          key={group.heading}
          title={group.heading}
          items={group.items.map((r) => (
            <>
              <Mono>{r.name}</Mono>
              {r.detail ? ` (${r.detail})` : ""}
            </>
          ))}
        />
      ))}
      {product.path.length > 1 ? (
        <div className="space-y-1">
          <h4 className="text-xs font-semibold uppercase text-muted-foreground">Edge path</h4>
          <div className="overflow-x-auto">
            <PortfolioPathDiagram path={product.path} edges={product.pathEdges} />
          </div>
        </div>
      ) : null}
      {product.hiddenEdgeCount > 0 ? (
        <p className="text-xs text-muted-foreground">
          {product.hiddenEdgeCount === 1
            ? "1 link out of this product touches a repository you cannot read, so it was not followed."
            : `${product.hiddenEdgeCount} links out of this product touch a repository you cannot read, so they were not followed.`}
        </p>
      ) : null}
    </Disclosure>
  );
}

function AffectedCard({ product }: { product: AffectedProduct }) {
  const via = viaLabel(product.via);
  return (
    <li
      className="space-y-2 rounded-lg border border-border p-4"
      data-testid="portfolio-affected-product"
      data-impact={product.impactKind}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold">
          {product.name ?? <span className="text-muted-foreground">A product you cannot read</span>}
        </h3>
        <Badge variant="outline" data-testid="portfolio-impact-kind">
          {IMPACT_LABEL[product.impactKind]}
        </Badge>
        {via ? <span className="text-xs text-muted-foreground">via {via}</span> : null}
        {product.severity ? <SeverityBadge severity={product.severity} /> : null}
      </div>
      {product.summary ? <p className="text-sm">{product.summary}</p> : null}
      {product.impactWithheld ? (
        <p className="text-xs text-muted-foreground">
          Its impact path goes through a repository or product you cannot read, so it is not shown.
        </p>
      ) : product.impactKind === "restricted" ? (
        // #1673 — the walk stopped at a product next to this one: not "not affected".
        // #1680 — the run's starter could not read it, which says nothing of this reader.
        <p className="text-xs text-muted-foreground" data-testid="portfolio-impact-unknown">
          It is connected to a product the check could not follow the change through, because the
          person who ran the check cannot read it, so whether the change reaches this one is not
          known.
        </p>
      ) : null}
      {product.restricted ? null : (
        <>
          {product.severity && product.derivation.length > 0 ? (
            <SeverityWhy product={product} />
          ) : null}
          <DeepDive product={product} />
        </>
      )}
    </li>
  );
}

export function PortfolioImpactView({
  affected,
  notAffected,
}: {
  affected: AffectedProduct[];
  notAffected: NotAffectedProduct[];
}) {
  const [showNotAffected, setShowNotAffected] = useState(false);
  const notAffectedId = useId();
  return (
    <section
      aria-labelledby="portfolio-impact-heading"
      className="space-y-3"
      data-testid="portfolio-impact-view"
    >
      <h2 id="portfolio-impact-heading" className="text-base font-semibold">
        Impact on your products
      </h2>
      {affected.length > 0 ? (
        <ul className="space-y-3">
          {affected.map((p) => (
            <AffectedCard key={p.productId} product={p} />
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground" data-testid="portfolio-impact-none">
          No product needs to change for this requirement.
        </p>
      )}
      {notAffected.length > 0 ? (
        <div data-testid="portfolio-not-affected">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="px-1"
            aria-expanded={showNotAffected}
            aria-controls={notAffectedId}
            onClick={() => setShowNotAffected((o) => !o)}
          >
            {showNotAffected ? (
              <ChevronDown className="h-4 w-4" aria-hidden />
            ) : (
              <ChevronRight className="h-4 w-4" aria-hidden />
            )}
            Not affected ({notAffected.length})
          </Button>
          {showNotAffected ? (
            <ul id={notAffectedId} className="mt-1 space-y-0.5 pl-6 text-sm">
              {notAffected.map((p) => (
                <li key={p.productId} data-testid="portfolio-not-affected-product">
                  {p.name ?? (
                    <span className="text-muted-foreground">A product you cannot read</span>
                  )}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
