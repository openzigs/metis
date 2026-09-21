/**
 * AI engine barrel — re-exports the public surface so route/middleware code
 * can `import { getProvider, getTokenTracker, ... } from "../lib/ai"`.
 */
export * from "./types.js";
export * from "./errors.js";
export * from "./config.js";
export * from "./embeddings.js";
export * from "./token-tracker.js";
export * from "./chat-system-prompt.js";
export * from "./tool-registry.js";
export * from "./approval-policy.js";
export * from "./copilot-wrapper.js";
export * from "./providers/offline-stub-provider.js";
export * from "./providers/copilot-provider.js";
export * from "./providers/factory.js";
export * from "./project-provider.js";
export * from "./fixtures/index.js";
export * from "./task-profiler.js";
export * from "./model-router.js";
export * from "./inference-profile-manager.js";
export * from "./token-budget-controller.js";
export * from "./cloudwatch-metrics.js";
