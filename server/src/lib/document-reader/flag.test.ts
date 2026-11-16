/**
 * #2255 — the document reader stays off by default (opt-in). Measured on
 * Sonnet 5.5 only, it holds the whole-document read's requirement recall and
 * precision on every document that read could answer
 * (docs/DOCUMENT_UNDERSTANDING_BASELINE.md), but costs several times as much and
 * takes several times as long a document, so the owner kept it an operator's
 * choice.
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
  it("is off when nothing sets it", () => {
    vi.stubEnv(DOCUMENT_READER_FLAG, undefined);
    __resetConfigSingleton();
    expect(DOCUMENT_READER_DEFAULT).toBe(false);
    expect(isDocumentReaderEnabled()).toBe(false);
  });

  it("is off when set empty, as an unset key reads", () => {
    vi.stubEnv(DOCUMENT_READER_FLAG, "");
    __resetConfigSingleton();
    expect(isDocumentReaderEnabled()).toBe(false);
  });

  it("an operator can turn it on", () => {
    vi.stubEnv(DOCUMENT_READER_FLAG, "true");
    __resetConfigSingleton();
    expect(isDocumentReaderEnabled()).toBe(true);
  });

  it("the registry entry says it is off by default, how to turn it on, and what it costs", () => {
    const def = getKeyDef(DOCUMENT_READER_FLAG);
    expect(def?.valueType).toBe("bool");
    expect(def?.description).toMatch(/OFF by default/);
    expect(def?.description).not.toMatch(/ON by default/);
    expect(def?.description).toMatch(/Set true/);
    expect(def?.description).toMatch(/\$0\.66 to \$1\.12/);
    expect(def?.description).toMatch(/Sonnet 5\.5 only/);
  });
});
