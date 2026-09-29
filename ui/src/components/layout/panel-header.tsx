/**
 * #31 — the header of a section that lives inside a page (a scope tab, a
 * concept panel). Same layout as `PageHeader`, but the title is an `h2`: the
 * page that hosts the panel owns the one `h1`.
 */
import type { ReactNode } from "react";

interface PanelHeaderProps {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}

export function PanelHeader({ title, description, actions }: PanelHeaderProps) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 space-y-1">
        {title ? <h2 className="text-lg font-semibold">{title}</h2> : null}
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}
