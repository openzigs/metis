/**
 * Record/replay LLM fixture harness (#234) — public surface.
 *
 * Import target for both the server (`maybeWrapProviderForFixtures`) and the
 * Playwright e2e suite, which can construct a {@link ReplayProvider} / read
 * fixtures directly:
 *
 *   import { ReplayProvider, FixtureStore, resolveFixtureDir } from
 *     "../../server/src/lib/ai/fixtures/index.js";
 *
 * See ./README.md for record-vs-replay usage and how to refresh fixtures.
 */
export { fixtureKey, keyedOptions, type KeyedChatOptions } from "./fixture-key.js";
export {
  FixtureStore,
  resolveFixtureDir,
  DEFAULT_FIXTURE_DIR,
  type FixtureRecord,
} from "./fixture-store.js";
export {
  ReplayProvider,
  ReplayFixtureMissError,
  type ReplayProviderOptions,
} from "./replay-provider.js";
export { RecordingProvider, type RecordingProviderOptions } from "./recording-provider.js";
export {
  maybeWrapProviderForFixtures,
  resolveFixtureMode,
  type FixtureMode,
  type InstallFixturesOptions,
} from "./install.js";
