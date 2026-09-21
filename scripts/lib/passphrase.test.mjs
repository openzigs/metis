import { describe, it, expect, afterEach } from "vitest";
import { readPassphrase, PassphraseError } from "./passphrase.mjs";

describe("readPassphrase", () => {
  const ENV_VAR = "METIS_TEST_PASSPHRASE_VAR";

  afterEach(() => {
    delete process.env[ENV_VAR];
  });

  it("returns the passphrase from the named env var when set", async () => {
    process.env[ENV_VAR] = "from-the-environment";
    const pass = await readPassphrase({ envVar: ENV_VAR });
    expect(pass).toBe("from-the-environment");
  });

  it("throws when env var is unset and stdin is not a TTY", async () => {
    const fakeInput = { isTTY: false };
    await expect(readPassphrase({ envVar: ENV_VAR, input: fakeInput })).rejects.toBeInstanceOf(
      PassphraseError,
    );
  });

  it("ignores an empty env var and falls through to the TTY check", async () => {
    process.env[ENV_VAR] = "";
    const fakeInput = { isTTY: false };
    await expect(readPassphrase({ envVar: ENV_VAR, input: fakeInput })).rejects.toBeInstanceOf(
      PassphraseError,
    );
  });
});
