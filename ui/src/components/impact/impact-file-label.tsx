/**
 * ImpactFileLabel — #1965.
 *
 * The heading of one file in an impact result. A project can connect several
 * repositories and the same path can exist in more than one, so when `repo` is
 * given the heading names the repository before the path. `children` follows
 * the path (a symbol count, say).
 */
"use client";

import type { ReactNode } from "react";
import type { ImpactSymbolRepoRef } from "@metis/shared";

export interface ImpactFileLabelProps {
  filePath: string;
  /** Given only when the caller decided the project has more than one repository. */
  repo?: ImpactSymbolRepoRef | null;
  className?: string;
  children?: ReactNode;
}

/** Without a repository it renders exactly the heading it replaced: `<p>path…</p>`. */
export function ImpactFileLabel({ filePath, repo, className, children }: ImpactFileLabelProps) {
  return (
    <p className={className}>
      {repo ? (
        <span
          className="mr-1.5 rounded border border-border/60 px-1 font-sans text-muted-foreground"
          data-testid="impact-file-repo"
        >
          {repo.name}
        </span>
      ) : null}
      {filePath}
      {children}
    </p>
  );
}
