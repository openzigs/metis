/**
 * #2255 — the document reader is on by default. Measured on Sonnet 5.5, it
 * holds the whole-document read's requirement recall and precision on every
 * document that read could answer (docs/DOCUMENT_UNDERSTANDING_BASELINE.md),
 * so an analysis reads a document in full unless an operator turns it off.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetConfigSingleton } from "../config/config-service.js";
import { getKeyDef } from "../config/key-registry.js";
import { DOCUMENT_READER_DEFAULT, DOCUMENT_READER_FLAG, isDocumentReaderEnabled } from "./flag.js";

beforeEach(() => {
  vi.unstubAllEnvs();
  __resetConfigSingleton();
});

afterEach(() => {
  vi.unstubAllEnvs();
  __resetConfigSingleton();
});

describe("#2255 — ANALYSIS_DOCUMENT_READER", () => {
  it("is on when nothing sets it", () => {
    vi.stubEnv(DOCUMENT_READER_FLAG, undefined);
    __resetConfigSingleton();
    expect(DOCUMENT_READER_DEFAULT).toBe(true);
    expect(isDocumentReaderEnabled()).toBe(true);
  });

  it("is on when set empty, as an unset key reads", () => {
    vi.stubEnv(DOCUMENT_READER_FLAG, "");
    __resetConfigSingleton();
    expect(isDocumentReaderEnabled()).toBe(true);
  });

  it("an operator can still turn it off", () => {
    vi.stubEnv(DOCUMENT_READER_FLAG, "false");
    __resetConfigSingleton();
    expect(isDocumentReaderEnabled()).toBe(false);
  });

  it("the registry entry tells the operator it is on by default", () => {
    const def = getKeyDef(DOCUMENT_READER_FLAG);
    expect(def?.valueType).toBe("bool");
    expect(def?.description).toMatch(/ON by default/);
    expect(def?.description).not.toMatch(/OFF by default/);
  });
});
