/**
 * #2230 — the document reader's flag. Off by default: #2229 measured whole-
 * document reading against today's ten chunks, not this reader (which writes
 * its statements a batch of sections at a time), and the epic's definition of
 * done asks for a 60 KB document's reading before a flag defaults on.
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
