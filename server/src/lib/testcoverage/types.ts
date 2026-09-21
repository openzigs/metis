/**
 * Re-export of the framework's public surface — kept thin so consumers can
 * `import { type ImportProvider } from "../testcoverage/types.js"` without
 * pulling in every provider.
 */
export type {
  CanonicalColumn,
  ImportProvider,
  ImportProviderContext,
  ImportProviderResult,
} from "./providers/types.js";
export {
  CANONICAL_COLUMNS,
  ColumnMappingRequiredError,
  COLUMN_ALIASES,
  MIN_COLUMN_MAPPING_CONFIDENCE,
} from "./providers/types.js";
