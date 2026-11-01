"use client";

/**
 * #1628 — the product page's integration edges and shared resources, and the
 * editor for the ones a person declares (#1620's API). Detection cannot see
 * every coupling (a shared identity provider, a nightly file drop, a rule
 * duplicated by hand); declaring it lets the impact walk (#1623) include it.
 *
 * The list reads the product through the same query the page uses, so after a
 * write the GET is fetched again and the rows shown are the server's.
 * Without the product edit right (`project.update`) the list is read-only: no
 * control is rendered, and the server refuses the writes anyway.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { PRODUCT_RESOURCE_KINDS, type ProductResourceKind } from "@metis/shared";
import { ApiError } from "@/lib/api-client";
import { productsApi, type ProductEdge, type ProductWithRepos } from "@/lib/products-api";
import {
  PRODUCT_COUPLING_STRENGTHS,
  PRODUCT_EDGE_DIRECTIONS,
  PRODUCT_EDGE_TYPES,
  PRODUCT_INTEGRATION_KINDS,
  confidenceLabel,
  declareEdgeBody,
  draftFromEdge,
  edgeDraftError,
  edgeTargetLabel,
  emptyEdgeDraft,
  filterEdgesByKind,
  isDeclaredEdge,
  originLabel,
  repoLabel,
  updateEdgeBody,
  type EdgeDraft,
  type EdgeKindFilter,
} from "@/lib/product-edges";
import { queryKeys } from "@/lib/query-keys";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

const SELECT_CLASS =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

function errorText(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

/** The open editor: a new edge, or the declared edge being changed. */
type Editing = { mode: "add" } | { mode: "edit"; edge: ProductEdge };

export function ProductEdgesPanel({ productId, canEdit }: { productId: string; canEdit: boolean }) {
  const qc = useQueryClient();
  const product = useQuery({
    queryKey: queryKeys.products.detail(productId),
    queryFn: () => productsApi.get(productId),
  });
  const [kindFilter, setKindFilter] = useState<EdgeKindFilter>("all");
  const [editing, setEditing] = useState<Editing | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);

  // Every write re-reads the product, so what is shown is what the GET returns.
  const refetch = () => qc.invalidateQueries({ queryKey: queryKeys.products.detail(productId) });

  const removeEdge = useMutation({
    mutationFn: (edgeId: string) => productsApi.deleteEdge(productId, edgeId),
    onSuccess: () => {
      setRowError(null);
      return refetch();
    },
    onError: (err) => setRowError(errorText(err, "Failed to delete the edge.")),
  });

  const overrideStrength = useMutation({
    mutationFn: ({ edgeId, strength }: { edgeId: string; strength: EdgeDraft["strength"] }) =>
      productsApi.updateEdge(productId, edgeId, { strength }),
    onSuccess: () => {
      setRowError(null);
      return refetch();
    },
    onError: (err) => setRowError(errorText(err, "Failed to override the strength.")),
  });

  if (!product.data) return null;
  const p = product.data;
  const edges = p.edges ?? [];
  const resources = p.resources ?? [];
  const repos = p.repos ?? [];
  const shown = filterEdgesByKind(edges, kindFilter);

  return (
    <section className="space-y-4" aria-labelledby="product-edges-heading">
      <div className="flex items-center justify-between">
        <h2 id="product-edges-heading" className="text-lg font-medium">
          Integration edges
        </h2>
        {canEdit && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => setEditing({ mode: "add" })}
            disabled={repos.length === 0}
          >
            <Plus className="mr-1 h-4 w-4" aria-hidden /> Declare edge
          </Button>
        )}
      </div>

      {!canEdit && (
        <p role="note" className="text-sm text-muted-foreground">
          Restricted: you can view these edges, but changing them needs edit rights on this product.
        </p>
      )}

      <div className="flex max-w-xs items-center gap-2">
        <Label htmlFor="edge-kind-filter" className="shrink-0">
          Filter by kind
        </Label>
        <select
          id="edge-kind-filter"
          value={kindFilter}
          onChange={(e) => setKindFilter(e.target.value as EdgeKindFilter)}
          className={SELECT_CLASS}
        >
          <option value="all">All kinds</option>
          {PRODUCT_INTEGRATION_KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
      </div>

      {rowError && (
        <p role="alert" className="text-sm text-destructive">
          {rowError}
        </p>
      )}

      {shown.length === 0 ? (
        <Card className="p-6 text-center">
          <p className="text-muted-foreground">
            {edges.length === 0 ? "No integration edges yet." : "No edges of this kind."}
          </p>
        </Card>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left">
              <tr>
                <th className="px-3 py-2 font-medium">From</th>
                <th className="px-3 py-2 font-medium">To</th>
                <th className="px-3 py-2 font-medium">Kind</th>
                <th className="px-3 py-2 font-medium">Strength</th>
                <th className="px-3 py-2 font-medium">Direction</th>
                <th className="px-3 py-2 font-medium">Origin</th>
                <th className="px-3 py-2 font-medium">Confidence</th>
                {canEdit && (
                  <th className="px-3 py-2 font-medium">
                    <span className="sr-only">Actions</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {shown.map((edge) => {
                const from = repoLabel(p, edge.sourceRepoId);
                const to = edgeTargetLabel(p, resources, edge);
                const name = `edge from ${from} to ${to}`;
                return (
                  <tr key={edge.id} className="border-t">
                    <td className="px-3 py-2">{from}</td>
                    <td className="px-3 py-2">{to}</td>
                    <td className="px-3 py-2">{edge.integrationKind ?? "unclassified"}</td>
                    <td className="px-3 py-2">
                      {canEdit && !isDeclaredEdge(edge) ? (
                        <select
                          aria-label={`Override strength of ${name}`}
                          value={edge.strength ?? ""}
                          disabled={overrideStrength.isPending}
                          onChange={(e) =>
                            overrideStrength.mutate({
                              edgeId: edge.id,
                              strength: e.target.value as EdgeDraft["strength"],
                            })
                          }
                          className={SELECT_CLASS}
                        >
                          {edge.strength === null && <option value="">unclassified</option>}
                          {PRODUCT_COUPLING_STRENGTHS.map((s) => (
                            <option key={s} value={s}>
                              {s}
                            </option>
                          ))}
                        </select>
                      ) : (
                        (edge.strength ?? "unclassified")
                      )}
                    </td>
                    <td className="px-3 py-2">{edge.direction ?? "unclassified"}</td>
                    <td className="px-3 py-2">
                      <Badge variant={isDeclaredEdge(edge) ? "secondary" : "outline"}>
                        {originLabel(edge.origin)}
                      </Badge>
                    </td>
                    <td className="px-3 py-2">{confidenceLabel(edge.confidence)}</td>
                    {canEdit && (
                      <td className="px-3 py-2 text-right whitespace-nowrap">
                        {isDeclaredEdge(edge) && (
                          <>
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label={`Edit ${name}`}
                              onClick={() => setEditing({ mode: "edit", edge })}
                            >
                              <Pencil className="h-4 w-4" aria-hidden />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label={`Delete ${name}`}
                              disabled={removeEdge.isPending}
                              onClick={() => removeEdge.mutate(edge.id)}
                            >
                              <Trash2 className="h-4 w-4 text-destructive" aria-hidden />
                            </Button>
                          </>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <SharedResources product={p} productId={productId} canEdit={canEdit} onSaved={refetch} />

      {canEdit && editing && (
        <EdgeEditorDialog
          key={editing.mode === "edit" ? editing.edge.id : "add"}
          product={p}
          productId={productId}
          editing={editing}
          onClose={() => setEditing(null)}
          onSaved={refetch}
        />
      )}
    </section>
  );
}

/** The add / edit form for a declared edge. */
function EdgeEditorDialog({
  product,
  productId,
  editing,
  onClose,
  onSaved,
}: {
  product: ProductWithRepos;
  productId: string;
  editing: Editing;
  onClose: () => void;
  onSaved: () => Promise<unknown>;
}) {
  const repos = product.repos ?? [];
  const resources = product.resources ?? [];
  const [draft, setDraft] = useState<EdgeDraft>(() =>
    editing.mode === "edit"
      ? draftFromEdge(editing.edge)
      : emptyEdgeDraft(repos[0]?.repoConnectionId),
  );
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () =>
      editing.mode === "edit"
        ? productsApi.updateEdge(productId, editing.edge.id, updateEdgeBody(draft))
        : productsApi.declareEdge(productId, declareEdgeBody(draft)),
    onSuccess: async () => {
      await onSaved();
      onClose();
    },
    onError: (err) => setError(errorText(err, "Failed to save the edge.")),
  });

  const set = <K extends keyof EdgeDraft>(key: K, value: EdgeDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const repoOptions = repos.map((r) => (
    <option key={r.repoConnectionId} value={r.repoConnectionId}>
      {repoLabel(product, r.repoConnectionId)}
    </option>
  ));

  const enumField = <K extends "edgeType" | "integrationKind" | "strength" | "direction">(
    key: K,
    label: string,
    values: readonly EdgeDraft[K][],
  ) => (
    <div className="space-y-1">
      <Label htmlFor={`edge-${key}`}>{label}</Label>
      <select
        id={`edge-${key}`}
        value={draft[key]}
        onChange={(e) => set(key, e.target.value as EdgeDraft[K])}
        className={SELECT_CLASS}
      >
        {values.map((v) => (
          <option key={v} value={v}>
            {v}
          </option>
        ))}
      </select>
    </div>
  );

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {editing.mode === "edit" ? "Edit declared edge" : "Declare an edge"}
          </DialogTitle>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            const invalid = edgeDraftError(draft);
            if (invalid) {
              setError(invalid);
              return;
            }
            setError(null);
            save.mutate();
          }}
        >
          <div className="space-y-1">
            <Label htmlFor="edge-source">From repository</Label>
            <select
              id="edge-source"
              value={draft.sourceRepoId}
              // The API does not let an edge change where it starts.
              disabled={editing.mode === "edit"}
              onChange={(e) => set("sourceRepoId", e.target.value)}
              className={SELECT_CLASS}
            >
              {repoOptions}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="edge-target">To repository</Label>
            <select
              id="edge-target"
              value={draft.targetRepoId}
              onChange={(e) => set("targetRepoId", e.target.value)}
              className={SELECT_CLASS}
            >
              <option value="">None (through a shared resource)</option>
              {repoOptions}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="edge-resource">Through shared resource</Label>
            <select
              id="edge-resource"
              value={draft.resourceId}
              onChange={(e) => set("resourceId", e.target.value)}
              className={SELECT_CLASS}
            >
              <option value="">None</option>
              {resources.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name} ({r.kind})
                </option>
              ))}
            </select>
          </div>
          {enumField("integrationKind", "Kind", PRODUCT_INTEGRATION_KINDS)}
          {enumField("strength", "Strength", PRODUCT_COUPLING_STRENGTHS)}
          {enumField("direction", "Direction", PRODUCT_EDGE_DIRECTIONS)}
          {enumField("edgeType", "Edge type", PRODUCT_EDGE_TYPES)}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <Button type="submit" className="w-full" disabled={save.isPending}>
            {save.isPending ? "Saving…" : "Save edge"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The product's shared resources, so an edge can be declared through one (a
 * shared identity provider has no repo of its own). A locator is free text and
 * is rendered as text, never as a link (#1620).
 */
function SharedResources({
  product,
  productId,
  canEdit,
  onSaved,
}: {
  product: ProductWithRepos;
  productId: string;
  canEdit: boolean;
  onSaved: () => Promise<unknown>;
}) {
  const resources = product.resources ?? [];
  const [kind, setKind] = useState<ProductResourceKind>("identity-provider");
  const [name, setName] = useState("");
  const [locator, setLocator] = useState("");
  const [error, setError] = useState<string | null>(null);

  const declare = useMutation({
    mutationFn: () =>
      productsApi.declareResource(productId, {
        kind,
        name: name.trim(),
        locator: locator.trim() || null,
      }),
    onSuccess: async () => {
      setName("");
      setLocator("");
      setError(null);
      await onSaved();
    },
    onError: (err) => setError(errorText(err, "Failed to declare the resource.")),
  });

  return (
    <div className="space-y-2">
      <h3 className="font-medium">Shared resources</h3>
      {resources.length === 0 ? (
        <p className="text-sm text-muted-foreground">No shared resources yet.</p>
      ) : (
        <ul className="space-y-1 text-sm" aria-label="Shared resources">
          {resources.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{r.name}</span>
              <span className="text-muted-foreground">({r.kind})</span>
              {r.locator && <code className="text-xs">{r.locator}</code>}
              <Badge variant="outline">{originLabel(r.origin)}</Badge>
            </li>
          ))}
        </ul>
      )}
      {canEdit && (
        <form
          className="flex flex-wrap items-end gap-2"
          aria-label="Declare a shared resource"
          onSubmit={(e) => {
            e.preventDefault();
            declare.mutate();
          }}
        >
          <div className="space-y-1">
            <Label htmlFor="resource-kind">Resource kind</Label>
            <select
              id="resource-kind"
              value={kind}
              onChange={(e) => setKind(e.target.value as ProductResourceKind)}
              className={SELECT_CLASS}
            >
              {PRODUCT_RESOURCE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="resource-name">Resource name</Label>
            <Input
              id="resource-name"
              value={name}
              maxLength={256}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="resource-locator">Locator (optional, no credentials)</Label>
            <Input
              id="resource-locator"
              value={locator}
              maxLength={512}
              onChange={(e) => setLocator(e.target.value)}
            />
          </div>
          <Button
            type="submit"
            size="sm"
            variant="outline"
            disabled={declare.isPending || !name.trim()}
          >
            Declare resource
          </Button>
          {error && (
            <p role="alert" className="w-full text-sm text-destructive">
              {error}
            </p>
          )}
        </form>
      )}
    </div>
  );
}
