import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Combine Tailwind class names with conditional logic and conflict resolution.
 * This is the canonical shadcn `cn` helper used by every UI-kit component.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
