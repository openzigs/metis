import {
  DOCSGEN_CHUNKER_IDENTITY,
  enqueueGeneratedDocPublication,
  generatedDocSyntheticDocumentId,
  publishGeneratedDocRevision,
  GENERATED_DOC_PUBLICATION_TASK_TYPE,
} from "./generated-doc-publication.js";

export {
  DOCSGEN_CHUNKER_IDENTITY,
  enqueueGeneratedDocPublication,
  generatedDocSyntheticDocumentId,
  publishGeneratedDocRevision,
  GENERATED_DOC_PUBLICATION_TASK_TYPE,
};

export async function ingestDocumentToRag(
  generatedDocumentId: string,
  projectId: string,
  markdown: string,
  options?: { version: number },
): Promise<{ revisionId: string; syntheticDocumentId: string }> {
  return enqueueGeneratedDocPublication({
    generatedDocumentId,
    projectId,
    markdown,
    version: options?.version ?? 1,
  });
}
