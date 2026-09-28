"use client";

import { Progress as ProgressPrimitive } from "radix-ui";
import { forwardRef } from "react";

const Progress = forwardRef<
  React.ComponentRef<typeof ProgressPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof ProgressPrimitive.Root> & { indicatorClassName?: string }
>(({ className, value, indicatorClassName, ...props }, ref) => (
  <ProgressPrimitive.Root
    ref={ref}
    className={`relative h-2 w-full overflow-hidden rounded-full bg-muted ${className ?? ""}`}
    {...props}
  >
    <ProgressPrimitive.Indicator
      className={`h-full rounded-full bg-info transition-all duration-300 ease-in-out ${indicatorClassName ?? ""}`}
      style={{ width: `${value ?? 0}%` }}
    />
  </ProgressPrimitive.Root>
));
Progress.displayName = "Progress";

export { Progress };
