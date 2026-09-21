/**
 * Publishing module — Phase 9 (#65–#71).
 *
 * Public surface for the GitHub publishing pipeline.
 */
export * from "./types.js";
export * from "./host-allowlist.js";
export * from "./dedup.js";
export * from "./label-sync.js";
export * from "./octokit-factory.js";
export * from "./dry-run.js";
export { archiveBatch as runArchive, configurePublisher, runBatch } from "./publisher.js";
export * from "./publishing-service.js";
export * from "./socket-emitter.js";
export { generateDrafts as generateDraftsLow } from "./draft-generator.js";
