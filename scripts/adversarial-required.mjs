#!/usr/bin/env node
/**
 * Does this branch need the adversarial review panel? (#1113, #1476)
 *
 * Runs git itself and fails closed. All logic is in `scripts/lib/adversarial-required-core.mjs`
 * and `scripts/lib/adversarial-tally-core.mjs`; this file only parses arguments and prints.
 *
 * Usage:
 *   pnpm review:adversarial-required [--base <ref>] [--head <ref>] [--title <text>] [--label <l>]...
 *
 * `--base` defaults to `origin/main`, `--head` to `HEAD`, `--title` to `$PR_TITLE`.
 *
 * Exit codes: 0 = answered (read `required` in the JSON), 2 = no answer could be computed — an
 * unknown ref, a shallow clone, an empty or unreadable diff. Exit 2 is never "not required".
 */

import { parseArgs } from "node:util";

import {
  AdversarialRequiredError,
  computeAdversarialRequirement,
  execGit,
} from "./lib/adversarial-required-core.mjs";

/** @type {ReturnType<typeof parseArgs>["values"]} */
let values;
try {
  ({ values } = parseArgs({
    options: {
      base: { type: "string" },
      head: { type: "string" },
      title: { type: "string" },
      label: { type: "string", multiple: true },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  }));
} catch (error) {
  process.stderr.write(`adversarial-required: ${/** @type {Error} */ (error).message}\n`);
  process.exit(2);
}

if (values.help) {
  process.stdout.write(
    [
      "Usage: pnpm review:adversarial-required [--base <ref>] [--head <ref>] [--title <text>] [--label <l>]...",
      "",
      "Prints { required, reasons, ... } as JSON. Exit 0 = answered; 2 = no answer (never 'not required').",
      "",
    ].join("\n"),
  );
  process.exit(0);
}

try {
  const result = computeAdversarialRequirement({
    git: execGit(process.cwd()),
    base: typeof values.base === "string" ? values.base : undefined,
    head: typeof values.head === "string" ? values.head : undefined,
    title: typeof values.title === "string" ? values.title : (process.env.PR_TITLE ?? ""),
    labels: Array.isArray(values.label) ? values.label.map(String) : [],
  });
  process.stdout.write(
    `${JSON.stringify(
      {
        required: result.required,
        reasons: result.reasons,
        base: result.base,
        mergeBase: result.mergeBase,
        head: result.head,
        changedPaths: result.changedPaths.length,
        addedImports: result.addedImports.length,
      },
      null,
      2,
    )}\n`,
  );
} catch (error) {
  const message =
    error instanceof AdversarialRequiredError
      ? error.message
      : String(/** @type {Error} */ (error)?.stack ?? error);
  process.stderr.write(`adversarial-required: ${message}\n`);
  process.exit(2);
}
