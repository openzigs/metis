import * as React from "react";

type BadgeVariant =
  | "default"
  | "secondary"
  | "destructive"
  | "outline"
  | "success"
  | "warning"
  | "info";

const variantClasses: Record<BadgeVariant, string> = {
  default: "bg-primary text-primary-foreground hover:bg-primary/80",
  secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
  destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/80",
  outline: "text-foreground border border-input",
  // #267 — semantic status variants on the success/warning/info tokens
  // (`ui/src/app/globals.css`). Text-on-tint contrast is asserted ≥4.5:1 in
  // both themes by `ui/tests/contrast-tokens.test.ts`, which is what the raw
  // `bg-amber-100 text-amber-*` badges these replace could not guarantee.
  success: "border-success/40 bg-success-muted text-success",
  warning: "border-warning/40 bg-warning-muted text-warning",
  info: "border-info/40 bg-info-muted text-info",
};

/**
 * The colour classes of a Badge variant, for an element that cannot BE a Badge
 * (a `<button>`: `Badge` renders a `<div>`, which is not valid button content).
 * Sharing them keeps such an element from drifting off the ui-kit style (#113).
 */
export function badgeVariantClasses(variant: BadgeVariant = "default"): string {
  return variantClasses[variant];
}

export interface BadgeProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: BadgeVariant;
}

export function Badge({ className = "", variant = "default", ...props }: BadgeProps) {
  return (
    <div
      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 ${variantClasses[variant]} ${className}`}
      {...props}
    />
  );
}
