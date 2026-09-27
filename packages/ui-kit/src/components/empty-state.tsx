import * as React from "react";
import { cn } from "../utils";

export interface EmptyStateProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
  /** Decorative icon; hidden from assistive tech. */
  icon?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  /** The next step, usually one Button or link. */
  action?: React.ReactNode;
  /**
   * Element for the title. A plain `p` by default; use a heading level when the
   * empty state stands in for a whole section, so it stays in the outline.
   */
  titleAs?: "p" | "h2" | "h3";
}

/**
 * #270 — shared empty state: what is missing, why, and the one action that
 * fixes it, in the same dashed panel everywhere.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  titleAs: Title = "p",
  className,
  ...props
}: EmptyStateProps) {
  return (
    <div
      data-slot="empty-state"
      className={cn(
        "flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed p-8 text-center",
        className,
      )}
      {...props}
    >
      {icon ? (
        <div aria-hidden="true" className="text-muted-foreground [&_svg]:size-8">
          {icon}
        </div>
      ) : null}
      <Title className="text-sm font-medium text-foreground">{title}</Title>
      {description ? (
        <div className="max-w-md text-sm text-muted-foreground">{description}</div>
      ) : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
