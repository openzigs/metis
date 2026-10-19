/**
 * #1261 — the two notices that tell a reader a product, or one of its documents,
 * is incomplete because of repository access. Both carry a count only: a hidden
 * repo is never named.
 */
import { EyeOff, TriangleAlert } from "lucide-react";
import { partialDocRepoCount, type ProductDocument } from "@/lib/products-api";

function repos(n: number): string {
  return n === 1 ? "1 repo" : `${n} repos`;
}

/** "N repos hidden" on the product page, when the caller cannot open some of its repos. */
export function HiddenReposNotice({ count }: { count: number | undefined }) {
  if (!count || count <= 0) return null;
  return (
    <div
      role="note"
      className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning-muted p-3 text-sm text-warning"
    >
      <EyeOff className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <p>
        <span className="font-medium">{repos(count)} hidden.</span> This product includes
        repositories you don&apos;t have access to, so they aren&apos;t listed here.
      </p>
    </div>
  );
}

/** Shown above a generated document that a run wrote without some of the product's repos. */
export function PartialDocNotice({ doc }: { doc: Pick<ProductDocument, "metadata"> }) {
  const missing = partialDocRepoCount(doc);
  if (missing === 0) return null;
  return (
    <div
      role="note"
      className="mb-4 flex items-start gap-2 rounded-md border border-warning/40 bg-warning-muted p-3 text-sm text-warning"
    >
      <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <p>
        <span className="font-medium">Incomplete document.</span> Built without {repos(missing)} the
        person who ran it couldn&apos;t access. A run by someone who can access every repository
        will replace it.
      </p>
    </div>
  );
}
