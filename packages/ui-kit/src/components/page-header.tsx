import * as React from "react";
import { cn } from "../utils";
import { Skeleton } from "./skeleton";

/**
 * #270 — the one page-title style. Page `<h1>`s had nine class combinations
 * (research #263, T7); every page now renders its title through
 * {@link PageHeader}, which applies this.
 */
export const PAGE_TITLE_CLASS = "text-2xl font-semibold tracking-tight";

export interface PageHeaderProps extends Omit<React.HTMLAttributes<HTMLElement>, "title"> {
  /** The page title, rendered as the page's single `<h1>`. */
  title: React.ReactNode;
  /** One or two sentences under the title. */
  description?: React.ReactNode;
  /** Page-level actions (buttons, pickers), right-aligned on wide screens. */
  actions?: React.ReactNode;
  /** A small line above the title, e.g. a "← Back to …" link. */
  eyebrow?: React.ReactNode;
  /** Shown beside the title (a status badge, an icon), outside the heading. */
  titleExtra?: React.ReactNode;
  /** `id` for the `<h1>`, for `aria-labelledby` on the page's region. */
  titleId?: string;
}

/**
 * #270 — shared page header: title, description and actions in one layout,
 * so every page starts the same way. Extra content (meta lines, notices) can
 * be passed as children and renders under the description.
 */
export function PageHeader({
  title,
  description,
  actions,
  eyebrow,
  titleExtra,
  titleId,
  className,
  children,
  ...props
}: PageHeaderProps) {
  return (
    <header
      data-slot="page-header"
      className={cn("flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between", className)}
      {...props}
    >
      <div className="min-w-0 space-y-1">
        {eyebrow ? <div className="text-xs text-muted-foreground">{eyebrow}</div> : null}
        {titleExtra ? (
          <div className="flex flex-wrap items-center gap-3">
            <h1 id={titleId} className={PAGE_TITLE_CLASS}>
              {title}
            </h1>
            {titleExtra}
          </div>
        ) : (
          <h1 id={titleId} className={PAGE_TITLE_CLASS}>
            {title}
          </h1>
        )}
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
        {children}
      </div>
      {actions ? (
        <div data-slot="page-header-actions" className="flex shrink-0 flex-wrap items-center gap-2">
          {actions}
        </div>
      ) : null}
    </header>
  );
}

export interface PageHeaderSkeletonProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Announced to assistive tech while the page loads. */
  label?: string;
}

/**
 * #270 — what a route `loading.tsx` shows: the shape of a {@link PageHeader}
 * followed by content lines, as an announced `role="status"` region.
 */
export function PageHeaderSkeleton({
  label = "Loading page…",
  className,
  ...props
}: PageHeaderSkeletonProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      className={cn("space-y-6", className)}
      {...props}
    >
      <span className="sr-only">{label}</span>
      <div className="space-y-2">
        <Skeleton className="h-8 w-64 max-w-full" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      <div className="space-y-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className={cn("h-3", i === 4 ? "w-2/3" : "w-full")} />
        ))}
      </div>
    </div>
  );
}
