/**
 * Pure audit core for the licence-metadata gate (#1296).
 *
 * ## Why this exists rather than a one-off edit
 *
 * #1296 sets `"license": "AGPL-3.0-only"` in ten manifests and asks for the
 * `private` flag to be **reviewed per package** rather than blanket-changed. A sweep
 * does both once. It does nothing about the eleventh manifest, which arrives with a
 * new package six weeks later carrying neither field — and which nothing would
 * notice, because a missing `license` breaks no build and an accidental
 * `private: false` is only discovered by an `npm publish` that cannot be undone.
 *
 * So the sweep ships with this behind it, and the audit is written along the axis
 * that actually fails: **identity, not content.** The policy below is not a list of
 * expected values to diff against — it is a register of manifests that have been
 * reviewed. A manifest on disk with no register entry is a problem (`unreviewed`),
 * and a register entry with no manifest is also a problem (`stale-policy`). The
 * previous shape of this mistake is #1168's family of gates that passed because
 * their default meant "nothing to check".
 *
 * ## Why every entry must carry a reason
 *
 * "Review `private` per package and record the reasoning" is a prose instruction, and
 * prose instructions are satisfied by writing prose somewhere and then losing it. A
 * required, non-empty `reason` on each entry makes the recording mechanical: the gate
 * fails on an entry that names a decision without saying why, so the reasoning cannot
 * be dropped while the decision survives.
 */

/** SPDX identifier every manifest in this repository must declare (#1296). */
export const OUTBOUND_LICENSE_ID = "AGPL-3.0-only";

/**
 * One reviewed manifest.
 *
 * Declared in its own comment block: a `@typedef` sharing a block with the
 * `@type {PolicyEntry[]}` that uses it makes the name resolve to the array, and
 * `tsc --noEmit` then reports every field access on an element as missing.
 *
 * @typedef {object} PolicyEntry
 * @property {string} path        repo-relative manifest path
 * @property {boolean} publishes  whether this package is intended for a registry
 * @property {string} reason      why, in terms specific to this package
 */

/**
 * The register of reviewed manifests.
 *
 * `publishes: false` means the manifest must carry `private: true`, which is npm's
 * own guard against an accidental publish. `publishes: true` would mean the package
 * is intended for the registry and must NOT carry it.
 *
 * Nothing in this repository is distributed through npm. METIS is distributed as
 * source (this repository, under AGPL-3.0) and as container images; the AGPL obliges
 * neither a registry release nor any particular channel. An accidental publish, by
 * contrast, is close to irreversible — npm unpublish is blocked after 72 hours — and
 * for an AGPL project it would put a package under our name on a registry whose
 * consumers overwhelmingly expect permissive terms. So every entry below is
 * `publishes: false`, and each says why it is false *for that package* rather than
 * inheriting a blanket rule.
 *
 * @type {PolicyEntry[]}
 */
export const PUBLICATION_POLICY = [
  {
    path: "package.json",
    publishes: false,
    reason:
      "the workspace root: a pnpm orchestration manifest with scripts and dev tooling " +
      "and no build output of its own. There is nothing here a consumer could install.",
  },
  {
    path: "server/package.json",
    publishes: false,
    reason:
      "an Express application, not a library. It is deployed as a container image and " +
      "carries a Prisma schema and migrations that are meaningless outside a METIS " +
      "deployment.",
  },
  {
    path: "ui/package.json",
    publishes: false,
    reason:
      "a Next.js application. Its build output is a server, not a package; `next build` " +
      "produces nothing a registry consumer could import.",
  },
  {
    path: "packages/shared/package.json",
    publishes: false,
    reason:
      "a library in shape, but its only consumers are workspace siblings resolving it " +
      "through `workspace:*`. Its `exports` point at `dist/`, built locally by the " +
      "monorepo. Publishing it would create an external contract nobody asked for and " +
      "that every internal change would then break.",
  },
  {
    path: "packages/ui-kit/package.json",
    publishes: false,
    reason:
      "same as `packages/shared`, and more so: it exports TypeScript SOURCE (`main` and " +
      "`types` both point at `src/index.ts`), so a registry consumer would need this " +
      "repository's exact build setup for it to compile at all.",
  },
  {
    path: "e2e/package.json",
    publishes: false,
    reason:
      "the Playwright suite. A test harness for this repository — it asserts against " +
      "METIS's own routes and fixtures and has no meaning anywhere else.",
  },
  {
    path: "scripts/package.json",
    publishes: false,
    reason:
      "repository tooling — the verification gates, the bootstrap and clean helpers. " +
      "Every script assumes this tree's layout.",
  },
  {
    path: "server/copilot-svc/package.json",
    publishes: false,
    reason:
      "a sidecar service deployed beside `server/`, shipped as a container image. It is " +
      "a process, not a package.",
  },
  {
    path: "server/embeddings-svc/package.json",
    publishes: false,
    reason: "a sidecar service, on the same reasoning as `server/copilot-svc`.",
  },
  {
    path: "images/mcp-wrappers/code-graph-runner-sse/package.json",
    publishes: false,
    reason:
      "the manifest of a Docker image build context, not a workspace member. It exists " +
      "so the image's own `npm install` resolves; it is never installed from a registry.",
  },
];

/**
 * A problem the audit found.
 *
 * @typedef {object} LicenseProblem
 * @property {"unreadable"|"unreviewed"|"stale-policy"|"unreasoned"|"missing-license"|"wrong-license"|"private-mismatch"} kind
 * @property {string} path
 * @property {string} message
 */

/**
 * Parse a manifest, distinguishing "not valid JSON" from "valid but wrong".
 *
 * @param {string} text
 * @returns {{ ok: true, value: Record<string, unknown> } | { ok: false, error: string }}
 */
function parseManifest(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: /** @type {Error} */ (error).message };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, error: "a package.json must be a JSON object" };
  }
  return { ok: true, value };
}

/**
 * Audit every manifest against the publication policy.
 *
 * Fails closed in both directions. A manifest that cannot be read or parsed is a
 * PROBLEM, not a skip — #1215 measured what the other behaviour costs on a sibling
 * gate, where a `catch { continue }` turned exit 1 into exit 0 while still counting
 * the file as scanned.
 *
 * @param {object} input
 * @param {Array<{ path: string, text: string | null }>} input.manifests every tracked
 *   manifest; `text` is `null` when the file could not be read
 * @param {PolicyEntry[]} [input.policy] the register; defaults to
 *   {@link PUBLICATION_POLICY}
 * @param {string} [input.licenseId] expected SPDX id; defaults to
 *   {@link OUTBOUND_LICENSE_ID}
 * @returns {{ problems: LicenseProblem[], reviewed: string[] }}
 */
export function auditLicenseMetadata({
  manifests,
  policy = PUBLICATION_POLICY,
  licenseId = OUTBOUND_LICENSE_ID,
}) {
  if (!Array.isArray(manifests)) {
    throw new TypeError("auditLicenseMetadata requires an array of manifests");
  }
  if (!Array.isArray(policy)) {
    throw new TypeError("auditLicenseMetadata requires an array policy");
  }

  /** @type {LicenseProblem[]} */
  const problems = [];
  const byPath = new Map(policy.map((entry) => [entry.path, entry]));
  const seen = new Set();

  // The reason requirement is checked over the whole policy, not only over entries
  // whose manifest happens to exist, so a reasonless entry cannot hide behind a
  // deleted file.
  for (const entry of policy) {
    if (typeof entry.reason !== "string" || entry.reason.trim().length === 0) {
      problems.push({
        kind: "unreasoned",
        path: entry.path,
        message: "policy entry records a publish decision with no reason for it",
      });
    }
  }

  for (const manifest of manifests) {
    seen.add(manifest.path);
    const entry = byPath.get(manifest.path);

    if (entry === undefined) {
      problems.push({
        kind: "unreviewed",
        path: manifest.path,
        message:
          "a manifest with no entry in PUBLICATION_POLICY — decide whether it publishes " +
          "and record why, in scripts/lib/license-metadata-core.mjs",
      });
      continue;
    }

    if (manifest.text === null) {
      problems.push({
        kind: "unreadable",
        path: manifest.path,
        message: "tracked but could not be read; treated as a failure, never as clean",
      });
      continue;
    }

    const parsed = parseManifest(manifest.text);
    if (!parsed.ok) {
      problems.push({
        kind: "unreadable",
        path: manifest.path,
        message: `could not be parsed: ${parsed.error}`,
      });
      continue;
    }

    const declared = parsed.value.license;
    if (declared === undefined) {
      problems.push({
        kind: "missing-license",
        path: manifest.path,
        message: `no "license" field; expected "${licenseId}"`,
      });
    } else if (declared !== licenseId) {
      problems.push({
        kind: "wrong-license",
        path: manifest.path,
        message: `declares "${String(declared)}"; expected "${licenseId}"`,
      });
    }

    const isPrivate = parsed.value.private === true;
    if (entry.publishes && isPrivate) {
      problems.push({
        kind: "private-mismatch",
        path: manifest.path,
        message: "policy says this package publishes, but `private: true` forbids it",
      });
    } else if (!entry.publishes && !isPrivate) {
      problems.push({
        kind: "private-mismatch",
        path: manifest.path,
        message:
          "policy says this package must never publish, but it does not carry " +
          "`private: true` — an accidental `npm publish` would succeed",
      });
    }
  }

  for (const entry of policy) {
    if (!seen.has(entry.path)) {
      problems.push({
        kind: "stale-policy",
        path: entry.path,
        message:
          "PUBLICATION_POLICY names a manifest that is not in the tree — remove the " +
          "entry, or the register no longer describes what is there",
      });
    }
  }

  return { problems, reviewed: [...seen].sort() };
}

/**
 * @param {{ problems: LicenseProblem[] }} result
 * @returns {boolean} true when nothing was found
 */
export function isClean(result) {
  return result.problems.length === 0;
}

/**
 * Render an audit result for a terminal.
 *
 * @param {{ problems: LicenseProblem[], reviewed: string[] }} result
 * @returns {string}
 */
export function formatReport(result) {
  if (isClean(result)) {
    return `licence metadata: ${result.reviewed.length} manifests, all "${OUTBOUND_LICENSE_ID}" and all reviewed for publication`;
  }
  const lines = [`licence metadata: ${result.problems.length} problem(s)`];
  for (const problem of result.problems) {
    lines.push(`  [${problem.kind}] ${problem.path}: ${problem.message}`);
  }
  return lines.join("\n");
}
