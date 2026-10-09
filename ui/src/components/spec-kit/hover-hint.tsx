"use client";

/**
 * #945 — a disabled `Button` has `pointer-events: none`, so its `title`
 * tooltip ("Requires project.update") never shows on hover. This wraps the
 * control in a span that receives the hover (and keyboard focus) and carries
 * the same hint. With no hint it renders the child alone.
 */
import type { ReactNode } from "react";

interface Props {
  hint: string | undefined;
  /** Layout classes for the wrapper, e.g. `flex w-full` for a full-width button. */
  className?: string;
  children: ReactNode;
}

export function HoverHint({ hint, className = "inline-flex", children }: Props) {
  if (!hint) return <>{children}</>;
  return (
    <span title={hint} tabIndex={0} className={className} data-hover-hint="">
      {children}
    </span>
  );
}
