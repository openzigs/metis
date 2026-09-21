/**
 * #785 — the dev-compose defaults must produce REAL embeddings.
 *
 * This guards a defect that no test could previously see, because it lived in the
 * gap between two correct-looking files: `docker-compose.yml` built, scheduled and
 * health-gated an embeddings sidecar holding real gte-modernbert weights, and then
 * set `AI_OFFLINE=1`, which outranks both `EMBED_BACKEND` and `EMBEDDINGS_MODE` in
 * `resolveBackendKey()`. The sidecar was never asked to embed anything and dev
 * indexed 384-dim hash noise — silently, and with every health check green.
 *
 * So this suite reads the REAL compose file, expands its `${VAR:-default}` defaults
 * exactly as `docker compose` would with an empty host environment, and asserts the
 * resulting env resolves the way we claim. Asserting on the YAML text alone would
 * only re-state the file; asserting through `resolveBackendKey` / `loadAIConfig`
 * tests the thing that actually decides.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadAIConfig } from "../src/lib/ai/config.js";
import { resolveBackendKey } from "../src/lib/rag/embedder-registry.js";

const COMPOSE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../docker-compose.yml",
);

interface ComposeFile {
  services: Record<string, { environment?: Record<string, string | number | null> }>;
}

/**
 * Expand `${VAR:-default}` / `${VAR-default}` / `${VAR}` the way `docker compose`
 * does, against a given host environment. Dev's baseline is an EMPTY host env —
 * that is the "default dev env" the acceptance criteria talk about.
 */
export function expandComposeValue(raw: string, hostEnv: Record<string, string> = {}): string {
  return raw.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::?-([^}]*))?\}/g,
    (_m, name: string, dflt = "") => {
      const value = hostEnv[name];
      // `:-` substitutes when unset OR empty; `-` only when unset. Compose's dev
      // defaults all use `:-`, and treating them alike is safe for an empty host env.
      return value === undefined || value === "" ? dflt : value;
    },
  );
}

/** The server service's environment, as `docker compose up` with no host overrides. */
function composeServerEnv(hostEnv: Record<string, string> = {}): Record<string, string> {
  const doc = yaml.load(fs.readFileSync(COMPOSE_PATH, "utf8")) as ComposeFile;
  const raw = doc.services.server.environment ?? {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === null || value === undefined) continue;
    out[key] = expandComposeValue(String(value), hostEnv);
  }
  return out;
}

describe("expandComposeValue", () => {
  it("takes the default when the host var is unset or empty", () => {
    expect(expandComposeValue("${AI_OFFLINE:-0}")).toBe("0");
    expect(expandComposeValue("${AI_OFFLINE:-0}", { AI_OFFLINE: "" })).toBe("0");
  });

  it("takes the host value when it is set", () => {
    expect(expandComposeValue("${AI_OFFLINE:-0}", { AI_OFFLINE: "1" })).toBe("1");
  });

  it("leaves a literal value alone", () => {
    expect(expandComposeValue("sidecar")).toBe("sidecar");
  });
});

describe("docker-compose.yml — server service defaults", () => {
  const ENV_KEYS = [
    "AI_OFFLINE",
    "AI_PROVIDER",
    "EMBED_BACKEND",
    "EMBED_MODEL",
    "EMBEDDINGS_MODE",
    "EMBEDDINGS_URL",
    "EMBEDDINGS_TOKEN",
    "NODE_ENV",
    "VITEST",
  ];

  beforeEach(() => {
    // The shared tests/setup.ts pins AI_OFFLINE=1 globally. Clear the whole
    // embedding-relevant surface so we are testing COMPOSE's defaults, not the
    // test harness's.
    for (const key of ENV_KEYS) vi.stubEnv(key, "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function applyComposeEnv(hostEnv: Record<string, string> = {}): Record<string, string> {
    const env = composeServerEnv(hostEnv);
    for (const key of ENV_KEYS) {
      if (env[key] !== undefined) vi.stubEnv(key, env[key]);
    }
    return env;
  }

  it("routes embeddings to the SIDECAR — not the hash stub — with a default dev env", async () => {
    const env = applyComposeEnv();

    // The regression this file exists for.
    expect(env.AI_OFFLINE).toBe("0");
    expect(resolveBackendKey()).toBe("sidecar");
    expect(resolveBackendKey()).not.toBe("offline");
  });

  it("points the sidecar backend at the compose-networked embeddings service", () => {
    const env = applyComposeEnv();
    expect(env.EMBEDDINGS_MODE).toBe("sidecar");
    expect(env.EMBEDDINGS_URL).toBe("http://embeddings:5050");
    expect(env.EMBEDDINGS_TOKEN).toBeTruthy();
  });

  it("does NOT default EMBED_MODEL to the hash stub id", () => {
    const env = applyComposeEnv();
    // `EMBED_MODEL=metis-offline-hash-v1` was the shipped .env default before
    // #783 and routes straight back to the stub (precedence rule 4).
    expect(env.EMBED_MODEL ?? "").not.toBe("metis-offline-hash-v1");
  });

  it("keeps the hash fallback DISABLED, so a broken sidecar fails loud (#783)", () => {
    const env = applyComposeEnv();
    expect(env.EMBED_ALLOW_HASH_FALLBACK ?? "").not.toMatch(/^(1|true|yes|on)$/i);
  });

  it("keeps the LLM offline-stubbed, so dev still needs no AI credentials", () => {
    const env = applyComposeEnv();
    // The whole reason the flip is safe: AI_PROVIDER carries the generative path's
    // offline-ness now, so dropping AI_OFFLINE does not send dev at a real LLM.
    expect(env.AI_PROVIDER).toBe("offline-stub");
    expect(loadAIConfig(env).offline).toBe(true);
  });

  it("still honours AI_OFFLINE=1 from the host env as a full opt-out", async () => {
    applyComposeEnv({ AI_OFFLINE: "1" });
    expect(resolveBackendKey()).toBe("offline");
    expect(loadAIConfig(composeServerEnv({ AI_OFFLINE: "1" })).offline).toBe(true);
  });
});
