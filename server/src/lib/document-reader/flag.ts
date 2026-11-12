/**
 * #2230 — the document reader's flag. Off by default. #2255 measured the
 * reader on four documents up to 60 KB: it finds every requirement, but at
 * 0.59 to 0.69 precision against the whole-document read's 1.00, mostly
 * repeats its cross-section pass keeps (docs/DOCUMENT_UNDERSTANDING_BASELINE.md).
 * It stays off until a re-measure shows it holds that read's precision.
 *
 * Read at call time through the config service (database, then environment),
 * so an operator's change in the admin UI applies to the next analysis.
 */
import { getConfigService } from "../config/config-service.js";

export const DOCUMENT_READER_FLAG = "ANALYSIS_DOCUMENT_READER";
export const DOCUMENT_READER_DEFAULT = false;

export function isDocumentReaderEnabled(): boolean {
  return getConfigService().getBool(DOCUMENT_READER_FLAG, DOCUMENT_READER_DEFAULT);
}
