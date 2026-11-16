/**
 * #2230 — the document reader's flag. On by default since #2255: measured on
 * Sonnet 5.5 at #2255's last reading, the reader holds the whole-document
 * read's requirement recall and precision (each no more than 0.05 below) on
 * every document that read could answer, and reads the 60 KB one it cannot
 * (docs/DOCUMENT_UNDERSTANDING_BASELINE.md). An operator can still turn it off.
 *
 * Read at call time through the config service (database, then environment),
 * so an operator's change in the admin UI applies to the next analysis.
 */
import { getConfigService } from "../config/config-service.js";

export const DOCUMENT_READER_FLAG = "ANALYSIS_DOCUMENT_READER";
export const DOCUMENT_READER_DEFAULT = true;

export function isDocumentReaderEnabled(): boolean {
  return getConfigService().getBool(DOCUMENT_READER_FLAG, DOCUMENT_READER_DEFAULT);
}
