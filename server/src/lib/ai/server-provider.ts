/**
 * #558 — the AI provider the server runs with, built from an environment.
 *
 * `server.ts` builds its provider here, and so does everything that must agree
 * with it about which provider (and so which model) serves a call — the
 * generative-e2e fixture builder keys its replay fixtures on the model the
 * running server will send. Restating the construction anywhere else is how
 * the two drift: the builder once hard-coded the offline stub, so with
 * `AI_PROVIDER` set to a real provider every clarify fixture missed.
 */
import { loadAIConfig } from "./config.js";
import { maybeWrapProviderForFixtures } from "./fixtures/install.js";
import { BedrockDirectProvider } from "./providers/bedrock-direct-provider.js";
import { buildProvider } from "./providers/factory.js";
import type { AIProvider } from "./types.js";

export function buildServerProvider(env: NodeJS.ProcessEnv = process.env): AIProvider {
  const config = loadAIConfig(env);
  if (
    (config.provider === "bedrock-gateway" || config.provider === "local-gemma") &&
    config.sdkProvider
  ) {
    return maybeWrapProviderForFixtures(
      new BedrockDirectProvider({
        baseUrl: config.sdkProvider.baseUrl,
        apiKey: config.sdkProvider.apiKey ?? "",
        model: config.model,
        providerKey: config.provider,
        modelProfileMap: config.modelProfileMap,
      }),
      { env },
    );
  }
  return buildProvider({ config, env });
}
