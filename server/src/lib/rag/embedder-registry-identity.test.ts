/**
 * #1944 - every registered backend that can report a `currentIdentity` also
 * reports a `knownIdentity`. The type does not enforce the pairing; without it
 * `Embedder.knownIdentity` falls back to the bare model and a pooling flip stops
 * moving the project content version (#792).
 */
import { describe, expect, it } from "vitest";
import { createBackend, listBackendKeys } from "./embedder-registry.js";
import "./embedder.js";

describe("embed backends: currentIdentity implies knownIdentity", () => {
  it("covers every registered backend that can be constructed", () => {
    const keys = listBackendKeys();
    expect(keys.length).toBeGreaterThan(0);
    let checked = 0;
    for (const key of keys) {
      let backend;
      try {
        backend = createBackend({ backend: key, client: {} as never });
      } catch {
        continue; // needs credentials or config to construct; nothing to check
      }
      checked++;
      if (typeof backend.currentIdentity === "function") {
        expect(typeof backend.knownIdentity, `backend "${key}"`).toBe("function");
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});
