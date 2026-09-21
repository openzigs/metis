"use client";

/**
 * Products index — list and create multi-repo products (Epic #544 / Issue #547).
 */
import Link from "next/link";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "@/lib/api-client";
import { productsApi } from "@/lib/products-api";
import { queryKeys } from "@/lib/query-keys";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SkeletonText } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

export default function ProductsPage() {
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: queryKeys.products.list({}),
    queryFn: () => productsApi.list(),
  });

  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugManuallyEdited, setSlugManuallyEdited] = useState(false);
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => productsApi.create({ name, slug, description: description || undefined }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.products.all });
      setOpen(false);
      setName("");
      setSlug("");
      setSlugManuallyEdited(false);
      setDescription("");
      setError(null);
    },
    onError: (err: unknown) => {
      setError(err instanceof ApiError ? err.message : "Failed to create product");
    },
  });

  return (
    <div className="space-y-6 p-2 md:p-0">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Products</h1>
          <p className="text-sm text-muted-foreground">
            Multi-repository product documentation — group repos, detect relationships, and generate
            unified docs.
          </p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button data-testid="new-product-button">New product</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create product</DialogTitle>
            </DialogHeader>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                create.mutate();
              }}
              className="space-y-4"
            >
              <div className="space-y-2">
                <Label htmlFor="product-name">Name</Label>
                <Input
                  id="product-name"
                  value={name}
                  onChange={(e) => {
                    const newName = e.target.value;
                    setName(newName);
                    if (!slugManuallyEdited) {
                      setSlug(
                        newName
                          .toLowerCase()
                          .replace(/[^a-z0-9\s-]/g, "")
                          .replace(/\s+/g, "-")
                          .replace(/-+/g, "-")
                          .replace(/^-|-$/g, ""),
                      );
                    }
                  }}
                  placeholder="My Product"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="product-slug">Slug</Label>
                <Input
                  id="product-slug"
                  value={slug}
                  onChange={(e) => {
                    setSlug(e.target.value);
                    setSlugManuallyEdited(true);
                  }}
                  placeholder="my-product"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="product-description">Description</Label>
                <Input
                  id="product-description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Optional description"
                />
              </div>
              {error && <p className="text-sm text-destructive">{error}</p>}
              <Button type="submit" disabled={create.isPending} className="w-full">
                {create.isPending ? "Creating…" : "Create"}
              </Button>
            </form>
          </DialogContent>
        </Dialog>
      </header>

      {list.isLoading && <SkeletonText lines={3} />}

      {list.data && list.data.items.length === 0 && (
        <Card className="p-8 text-center">
          <p className="text-muted-foreground">
            No products yet. Create one to start grouping repositories and generating documentation.
          </p>
        </Card>
      )}

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {list.data?.items.map((product) => (
          <Link key={product.id} href={`/products/${product.id}`}>
            <Card className="p-4 hover:border-primary/50 transition-colors cursor-pointer">
              <h3 className="font-medium">{product.name}</h3>
              <p className="text-sm text-muted-foreground line-clamp-2">
                {product.description || "No description"}
              </p>
              <p className="text-xs text-muted-foreground mt-2">
                {new Date(product.createdAt).toLocaleDateString()}
              </p>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
