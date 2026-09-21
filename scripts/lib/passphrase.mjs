/**
 * Passphrase resolution for the encrypted vault-key sidecar.
 *
 * Resolution order:
 *   1. The named environment variable (default METIS_EXPORT_PASSPHRASE).
 *   2. An interactive TTY prompt with echo disabled.
 *
 * The passphrase is NEVER read from argv — argv leaks into shell history and
 * the process table. If no env var is set and stdin is not a TTY (e.g. CI or a
 * piped invocation), this throws rather than silently blocking.
 *
 * Node built-ins only.
 */
import readline from "node:readline";

export class PassphraseError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "PassphraseError";
  }
}

/**
 * @typedef {object} ReadPassphraseOpts
 * @property {string} [envVar] env var name to read (default METIS_EXPORT_PASSPHRASE).
 * @property {string} [prompt] interactive prompt text.
 * @property {(NodeJS.ReadStream | { isTTY?: boolean })} [input] input stream (test seam).
 * @property {NodeJS.WritableStream} [output] prompt sink (test seam).
 */

/**
 * Resolve a passphrase from env, falling back to an interactive prompt.
 *
 * @param {ReadPassphraseOpts} [opts]
 * @returns {Promise<string>} the resolved passphrase.
 */
export async function readPassphrase(opts = {}) {
  const envVar = opts.envVar ?? "METIS_EXPORT_PASSPHRASE";
  const fromEnv = process.env[envVar];
  if (typeof fromEnv === "string" && fromEnv.length > 0) {
    return fromEnv;
  }

  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stderr;

  if (!input.isTTY) {
    throw new PassphraseError(
      `no passphrase available: set ${envVar} or run interactively from a TTY ` +
        `(the passphrase is never accepted via argv)`,
    );
  }

  const prompt = opts.prompt ?? "Vault-key passphrase: ";
  return await new Promise((resolve) => {
    const rl = readline.createInterface({
      input: /** @type {NodeJS.ReadableStream} */ (input),
      output,
      terminal: true,
    });
    // Disable echo so the passphrase is not displayed. `_writeToOutput` is the
    // documented seam for muting readline echo (no public alternative exists).
    const origWrite = output.write.bind(output);
    const muted = /** @type {{ _writeToOutput?: (s: string) => void }} */ (
      /** @type {unknown} */ (rl)
    );
    muted._writeToOutput = (/** @type {string} */ str) => {
      if (str.includes("\n") || str === prompt) {
        origWrite(str);
      }
      // Suppress echoed characters.
    };
    rl.question(prompt, (answer) => {
      rl.close();
      origWrite("\n");
      resolve(answer);
    });
  });
}
