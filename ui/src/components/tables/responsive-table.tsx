/**
 * ResponsiveTable — mobile-tuned data table (Epic #55 / #60).
 *
 * WCAG 2.2 AA coverage:
 *   - 1.4.10 Reflow: below the 768px breakpoint rows render as stacked cards
 *     instead of a horizontally scrolling table, so content reflows to a single
 *     column with no 2-D scroll.
 *   - 2.5.8 Target Size (Minimum): interactive cell content should use
 *     `touchTargetClass` so touch targets are ≥44×44px on mobile.
 *
 * Screen-reader semantics are preserved across both layouts:
 *   - Desktop (≥768px): a real <table> with <th scope="col"> headers.
 *   - Mobile (<768px): each row is a <li> card whose fields are <dt>/<dd>
 *     pairs, so every value keeps its column label as an associated name and
 *     the top-to-bottom reading order matches the table's column order.
 *
 * Exactly one layout is mounted at a time — the active layout is chosen at
 * runtime from a `matchMedia` query. Rendering a single layout (rather than
 * both with CSS `display:none`) keeps the DOM free of duplicated labels/values,
 * which matters both for assistive tech and for text-based test queries. The
 * initial (and server/no-`matchMedia`) render is the desktop table; the effect
 * flips to cards on narrow viewports after mount.
 */
import * as React from "react";
import { cn } from "@/lib/utils";

/** Tailwind `md` breakpoint. Below this width the table reflows to cards. */
const MOBILE_QUERY = "(max-width: 767.98px)";

/**
 * Utility class for interactive cell content (links, buttons, checkboxes) so it
 * meets the ≥44×44px touch target on mobile while staying compact on desktop.
 */
export const touchTargetClass =
  "inline-flex min-h-[44px] min-w-[44px] items-center md:min-h-0 md:min-w-0";

/** Subscribes to a media query; returns false until mounted (SSR-safe). */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = React.useState(false);
  React.useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia(query);
    const update = () => setMatches(mql.matches);
    update();
    mql.addEventListener("change", update);
    return () => mql.removeEventListener("change", update);
  }, [query]);
  return matches;
}

export interface ResponsiveColumn<T> {
  /** Stable identity for the column (used as React key). */
  key: string;
  /** Column header — also the mobile card field label unless `cardLabel` is set. */
  header: React.ReactNode;
  /** Renders the cell/field value for a row. */
  cell: (row: T) => React.ReactNode;
  /** Text label to associate with the value on the mobile card when `header`
   *  is visual-only (icon, sr-only span). Falls back to `header`. */
  cardLabel?: string;
  /** Omit the field label on the mobile card (e.g. an actions column). */
  hideCardLabel?: boolean;
  /** Extra classes on the desktop <th>. */
  headerClassName?: string;
  /** Extra classes on the desktop <td>. */
  cellClassName?: string;
  /** Right-align the header/cell on desktop (numeric columns). */
  align?: "left" | "right";
}

export interface ResponsiveTableProps<T> {
  columns: ReadonlyArray<ResponsiveColumn<T>>;
  data: ReadonlyArray<T>;
  /** Stable key per row. */
  getRowKey: (row: T, index: number) => string;
  /** Accessible name applied to both the table and the mobile card list. */
  ariaLabel?: string;
  /** Optional visible caption. */
  caption?: React.ReactNode;
  /** Rendered in both layouts when `data` is empty. */
  emptyContent?: React.ReactNode;
  /** Extra classes on the outer wrapper. */
  className?: string;
  /** Per-row test id (applied to desktop <tr> and mobile <li>). */
  rowTestId?: (row: T) => string;
  "data-testid"?: string;
}

/**
 * Renders a semantic data table on wide viewports and a stacked card list on
 * narrow ones. See the file header for the accessibility rationale.
 */
export function ResponsiveTable<T>({
  columns,
  data,
  getRowKey,
  ariaLabel,
  caption,
  emptyContent,
  className,
  rowTestId,
  ...rest
}: ResponsiveTableProps<T>): React.JSX.Element {
  const isMobile = useMediaQuery(MOBILE_QUERY);
  const isEmpty = data.length === 0;
  const testId = rest["data-testid"];

  if (isMobile) {
    return (
      <div className={className} data-testid={testId}>
        {isEmpty ? (
          <div className="py-3 text-sm text-muted-foreground">{emptyContent}</div>
        ) : (
          <ul className="space-y-3" aria-label={ariaLabel}>
            {data.map((row, index) => (
              <li
                key={getRowKey(row, index)}
                className="rounded-lg border p-3"
                data-testid={rowTestId?.(row)}
              >
                <dl className="grid grid-cols-1 gap-2">
                  {columns.map((col) => (
                    <div key={col.key} className="flex items-start justify-between gap-3">
                      {col.hideCardLabel ? null : (
                        <dt className="shrink-0 text-xs font-medium text-muted-foreground">
                          {col.cardLabel ?? col.header}
                        </dt>
                      )}
                      <dd
                        className={cn(
                          "min-w-0 text-right text-sm",
                          col.hideCardLabel && "w-full text-left",
                        )}
                      >
                        {col.cell(row)}
                      </dd>
                    </div>
                  ))}
                </dl>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  return (
    <div className={cn("overflow-x-auto", className)} data-testid={testId}>
      <table className="w-full text-left text-sm" aria-label={ariaLabel}>
        {caption ? (
          <caption className="mb-2 text-left text-sm text-muted-foreground">{caption}</caption>
        ) : null}
        <thead>
          <tr className="border-b text-xs text-muted-foreground">
            {columns.map((col) => (
              <th
                key={col.key}
                scope="col"
                className={cn(
                  "py-2 pr-3 font-medium",
                  col.align === "right" && "text-right",
                  col.headerClassName,
                )}
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {isEmpty ? (
            <tr>
              <td colSpan={columns.length} className="py-3 text-sm text-muted-foreground">
                {emptyContent}
              </td>
            </tr>
          ) : (
            data.map((row, index) => (
              <tr key={getRowKey(row, index)} className="border-t" data-testid={rowTestId?.(row)}>
                {columns.map((col) => (
                  <td
                    key={col.key}
                    className={cn(
                      "py-2 pr-3 align-top",
                      col.align === "right" && "text-right",
                      col.cellClassName,
                    )}
                  >
                    {col.cell(row)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
