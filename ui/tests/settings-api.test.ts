import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadProviderPrefs,
  saveProviderPrefs,
  resetProviderPrefs,
  _DEFAULT_PROVIDER_PREFS as DEFAULT_PROVIDER_PREFS,
} from "@/lib/settings-api";

describe("settings-api provider prefs", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
  });

  it("returns defaults when nothing stored", () => {
    expect(loadProviderPrefs()).toEqual(DEFAULT_PROVIDER_PREFS);
  });

  it("round-trips a saved value", () => {
    saveProviderPrefs({
      defaultProvider: "openai",
      defaultModel: "gpt-4o",
      reasoningEffort: "high",
    });
    expect(loadProviderPrefs()).toEqual({
      defaultProvider: "openai",
      defaultModel: "gpt-4o",
      reasoningEffort: "high",
    });
  });

  it("falls back to defaults on corrupt JSON", () => {
    window.localStorage.setItem("metis.settings.providerPrefs", "{not json");
    expect(loadProviderPrefs()).toEqual(DEFAULT_PROVIDER_PREFS);
  });

  it("normalises an unknown reasoningEffort", () => {
    window.localStorage.setItem(
      "metis.settings.providerPrefs",
      JSON.stringify({
        defaultProvider: "x",
        defaultModel: "y",
        reasoningEffort: "lazy",
      }),
    );
    const prefs = loadProviderPrefs();
    expect(prefs.reasoningEffort).toBe(DEFAULT_PROVIDER_PREFS.reasoningEffort);
  });

  it("resetProviderPrefs returns to defaults", () => {
    saveProviderPrefs({
      defaultProvider: "openai",
      defaultModel: "gpt-4o",
      reasoningEffort: "minimal",
    });
    resetProviderPrefs();
    expect(loadProviderPrefs()).toEqual(DEFAULT_PROVIDER_PREFS);
  });
});
