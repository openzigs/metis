/**
 * Issue #935 — air-gapped sidecar env configuration.
 *
 * Verifies `configureTransformersEnv` flips `@huggingface/transformers` into offline mode
 * when an offline flag is set, and resolves the model cache directory from the
 * documented env vars.
 */
import { describe, expect, it } from "vitest";
import { configureTransformersEnv, HF_DEFAULT_REMOTE_HOST } from "../src/pipelines.js";

type Env = {
  allowRemoteModels?: boolean;
  allowLocalModels?: boolean;
  cacheDir?: string;
  remoteHost?: string;
};

describe("configureTransformersEnv", () => {
  it("allows remote models by default (online sidecar)", () => {
    const env: Env = {};
    configureTransformersEnv(env, {});
    expect(env.allowRemoteModels).toBe(true);
    expect(env.cacheDir).toBeUndefined();
  });

  it("disables remote models when HF_HUB_OFFLINE is set", () => {
    const env: Env = {};
    configureTransformersEnv(env, { HF_HUB_OFFLINE: "1" });
    expect(env.allowRemoteModels).toBe(false);
    expect(env.allowLocalModels).toBe(true);
  });

  it("honors TRANSFORMERS_OFFLINE and EMBEDDINGS_OFFLINE flags", () => {
    const a: Env = {};
    configureTransformersEnv(a, { TRANSFORMERS_OFFLINE: "true" });
    expect(a.allowRemoteModels).toBe(false);

    const b: Env = {};
    configureTransformersEnv(b, { EMBEDDINGS_OFFLINE: "yes" });
    expect(b.allowRemoteModels).toBe(false);
  });

  it("treats falsey/unknown flag values as online", () => {
    const env: Env = {};
    configureTransformersEnv(env, { HF_HUB_OFFLINE: "0", TRANSFORMERS_OFFLINE: "false" });
    expect(env.allowRemoteModels).toBe(true);
  });

  it("resolves cacheDir from EMBEDDINGS_CACHE_DIR first, then TRANSFORMERS_CACHE", () => {
    const a: Env = {};
    configureTransformersEnv(a, {
      EMBEDDINGS_CACHE_DIR: "/var/cache/metis",
      TRANSFORMERS_CACHE: "/hf",
    });
    expect(a.cacheDir).toBe("/var/cache/metis");

    const b: Env = {};
    configureTransformersEnv(b, { TRANSFORMERS_CACHE: "/hf" });
    expect(b.cacheDir).toBe("/hf");
  });

  /**
   * Issue #784 — internal mirror. transformers.js reads no env vars of its own,
   * so `HF_ENDPOINT` does nothing unless we map it onto `env.remoteHost`.
   */
  it("points downloads at the HF_ENDPOINT mirror when online", () => {
    const env: Env = {};
    configureTransformersEnv(env, { HF_ENDPOINT: "https://hf-mirror.corp.example" });
    expect(env.remoteHost).toBe("https://hf-mirror.corp.example/");
    expect(env.allowRemoteModels).toBe(true);
  });

  it("ignores the mirror when offline — an air-gapped image fetches from NOWHERE", () => {
    const env: Env = {};
    configureTransformersEnv(env, {
      HF_HUB_OFFLINE: "1",
      HF_ENDPOINT: "https://hf-mirror.corp.example",
    });
    expect(env.remoteHost).not.toContain("hf-mirror.corp.example");
    expect(env.allowRemoteModels).toBe(false);
  });

  /**
   * F4. The empty-fixture test above asserted a WEAKER property than it read as:
   * it passed even when the offline branch merely declined to assign, so an `env`
   * that had already been configured online (transformers.js exports a SHARED,
   * mutable module-level `env`) would have kept its mirror. These two pin the
   * real behaviour — including the reason it is a RESET and not a `delete`.
   */
  it("RESETS a remoteHost that was already set to a mirror", () => {
    const env: Env = { remoteHost: "https://hf-mirror.corp.example/", allowRemoteModels: true };
    configureTransformersEnv(env, { HF_HUB_OFFLINE: "1" });
    expect(env.remoteHost).toBe(HF_DEFAULT_REMOTE_HOST);
    expect(env.remoteHost).not.toContain("hf-mirror.corp.example");
    expect(env.allowRemoteModels).toBe(false);
    expect(env.allowLocalModels).toBe(true);
  });

  it("leaves remoteHost a STRING offline — deleting it hard-crashes every model load", () => {
    // Not a style point. transformers.js computes
    //   remoteURL = pathJoin(env.remoteHost, env.remotePathTemplate…)
    // eagerly on EVERY file load, before it checks allowRemoteModels, and
    // pathJoin calls .replace() on each part. `delete env.remoteHost` therefore
    // turns an air-gapped image into one that throws "Cannot read properties of
    // undefined (reading 'replace')" on its first embed — the exact failure class
    // this epic exists to prevent. Verified against the real image; the mocked
    // transformers.js in these tests cannot see it, so the invariant is asserted
    // here explicitly.
    const env: Env = {};
    configureTransformersEnv(env, { HF_HUB_OFFLINE: "1" });
    expect(typeof env.remoteHost).toBe("string");
    expect(env.remoteHost).toBeTruthy();
  });

  it("throws on a malformed mirror rather than silently using huggingface.co", () => {
    expect(() => configureTransformersEnv({}, { HF_ENDPOINT: "hf-mirror.corp.example" })).toThrow(
      /Invalid HF_ENDPOINT/,
    );
  });
});
