"use client";

/**
 * Issue #30 — Previous / Next paging for the Analysis page's long lists.
 *
 * Renders nothing when everything fits on one page, so a short run reads
 * exactly as it did before paging existed.
 */
import { Button } from "@/components/ui/button";
import type { Page } from "@/components/analysis/analysis-views";

export function ListPager({
  page,
  noun,
  onPageChange,
  testId,
}: {
  page: Page<unknown>;
  /** Plural noun for the range text, e.g. "findings". */
  noun: string;
  onPageChange: (page: number) => void;
  testId: string;
}): React.ReactElement | null {
  if (page.pageCount <= 1) return null;
  return (
    <nav
      aria-label={`${noun} pages`}
      data-testid={testId}
      className="flex items-center justify-between gap-2 text-xs text-muted-foreground"
    >
      <span data-testid={`${testId}-range`}>
        Showing {page.from}–{page.to} of {page.total} {noun}
      </span>
      <span className="flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => onPageChange(page.page - 1)}
          disabled={page.page === 0}
        >
          Previous
        </Button>
        <span aria-live="polite">
          Page {page.page + 1} of {page.pageCount}
        </span>
        <Button
          size="sm"
          variant="outline"
          onClick={() => onPageChange(page.page + 1)}
          disabled={page.page >= page.pageCount - 1}
        >
          Next
        </Button>
      </span>
    </nav>
  );
}
