/**
 * Env-driven installer for the record/replay LLM fixture harness (#234).
 *
 * This is the single seam the running server uses to opt into record or replay
 * mode. {@link maybeWrapProviderForFixtures} is called with the freshly-built
 * {@link AIProvider} and decides — purely from environment variables — whether
 * to return it unchanged, wrap it in a {@link RecordingProvider}, or replace it
 * with a {@link ReplayProvider}.
 *
 * Environment variables:
 *   - `AI_REPLAY=1`      — serve `.chat()` from fixtures (no live LLM needed).
 *   - `AI_RECORD=1`      — pass through to the real provider and capture to
 *                          fixtures. Requires real LLM credentials.
 *   - `AI_FIXTURE_DIR`   — fixture directory (default `tests/fixtures/llm`,
 *                          relative to the server cwd). Shared by both modes.
 *   - `AI_RECORD_OVERWRITE=1` — in record mode, refresh existing fixtures.
 *
 * Replay takes precedence if both flags are set. When neither flag is set the
 * provider is returned untouched, so production behaviour is unaffected.
 */
import type { AIProvider } from "../types.js";
import { OfflineStubProvider } from "../providers/offline-stub-provider.js";
import { FixtureStore, resolveFixtureDir } from "./fixture-store.js";
import { RecordingProvider } from "./recording-provider.js";
import { ReplayProvider } from "./replay-provider.js";

const truthy = (v: string | undefined): boolean => v === "1" || v?.toLowerCase() === "true";

export type FixtureMode = "record" | "replay" | "off";

/** Resolve the active harness mode from the environment. Replay wins ties. */
export function resolveFixtureMode(env: NodeJS.ProcessEnv = process.env): FixtureMode {
  if (truthy(env.AI_REPLAY)) return "replay";
  if (truthy(env.AI_RECORD)) return "record";
  return "off";
}

export interface InstallFixturesOptions {
  /** Override the environment used to resolve the mode (tests inject this). */
  env?: NodeJS.ProcessEnv;
  /** Override the fixture directory (defaults to {@link resolveFixtureDir}). */
  fixtureDir?: string;
  /** Fallback provider used by replay for `embed()` / fixture misses. */
  fallbackProvider?: AIProvider;
}

/**
 * Given a built provider, return the provider the server should actually use
 * based on the fixture-harness env flags.
 *
 *   - `replay` → a {@link ReplayProvider} (the original provider is discarded;
 *     a fallback is still used for `embed()` and, optionally, chat misses).
 *   - `record` → the original provider wrapped in a {@link RecordingProvider}.
 *   - `off`    → the original provider, unchanged.
 */
export function maybeWrapProviderForFixtures(
  provider: AIProvider,
  opts: InstallFixturesOptions = {},
): AIProvider {
  const env = opts.env ?? process.env;
  const mode = resolveFixtureMode(env);
  if (mode === "off") return provider;

  const dir = opts.fixtureDir ?? resolveFixtureDir();
  const store = new FixtureStore(dir);

  if (mode === "replay") {
    return new ReplayProvider({
      store,
      fallbackProvider: opts.fallbackProvider ?? new OfflineStubProvider(),
      key: provider.key,
      model: provider.model,
    });
  }

  // record
  return new RecordingProvider({
    inner: provider,
    store,
    overwrite: truthy(env.AI_RECORD_OVERWRITE),
  });
}
