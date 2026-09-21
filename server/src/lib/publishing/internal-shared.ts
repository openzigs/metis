/**
 * Re-exports of `@metis/shared` publishing types so internal modules can
 * import them via a stable local path without coupling to the package
 * directory layout.
 */
export type {
  DryRunAction,
  DryRunPlan,
  IssueDraft,
  PublishBatch,
  PublishedIssue,
} from "@metis/shared";
export type { GhLabel } from "./types.js";
