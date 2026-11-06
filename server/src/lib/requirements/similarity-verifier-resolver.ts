/**
 * Issue #1837 — the verifier a similarity request runs: none unless
 * `REQ_SIMILARITY_VERIFIER` is on, then the project's own provider (its
 * per-project override honoured). A provider that cannot be built leaves the
 * request on its threshold labels, logged, rather than failing it.
 */
import { createChildLogger } from "../logger.js";
import { resolveProjectProvider } from "../ai/project-provider.js";
import {
  createLlmSimilarityVerifier,
  similarityVerifierEnabled,
  type SimilarityVerifier,
} from "./similarity-verifier.js";

const log = createChildLogger("similarity-verifier");

export async function resolveSimilarityVerifier(
  projectId: string,
): Promise<SimilarityVerifier | null> {
  if (!similarityVerifierEnabled()) return null;
  try {
    return createLlmSimilarityVerifier(await resolveProjectProvider(projectId));
  } catch (err) {
    log.warn("similarity verifier unavailable; using the threshold labels", {
      projectId,
      error: (err as Error).message,
    });
    return null;
  }
}
