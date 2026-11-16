/**
 * #2230 — the document reader's flag. Off by default (opt-in). #2255's last
 * reading, on Sonnet 5.5 only, found the reader holds the whole-document read's
 * requirement recall and precision (each no more than 0.05 below) on every
 * document that read could answer, and reads the 60 KB one it cannot
 * (docs/DOCUMENT_UNDERSTANDING_BASELINE.md). The owner kept it opt-in for its
 * cost and time: about $0.66 to $1.12 and 3.5 to 7 minutes a document, against
 * $0.10 to $0.19 and 1 to 1.5 minutes for a whole-document read.
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
