/**
 * Dependabot / pnpm-workspace scope guard (#1283).
 *
 * ## The defect this exists to prevent
 *
 * `.github/dependabot.yml` declared TWO npm ecosystems — `directory: "/"` and
 * `directory: "/ui"` — while the repository holds exactly one lockfile,
 * `pnpm-lock.yaml` at the root. `ui` is a pnpm workspace member, so its dependencies
 * are pinned in that root lockfile and nowhere else.
 *
 * Dependabot ran the `/ui` entry as if `ui` were an independent project: it rewrote
 * `ui/package.json` and had no lockfile in that directory to regenerate. The root
 * lockfile was left describing the old ranges, and every CI job died on
 * `ERR_PNPM_OUTDATED_LOCKFILE` — PRs #1197, #1198, #1199 and #1200, all four.
 *
 * ## Why the root entry is sufficient — measured, not assumed
 *
 * PR #1248 is the `directory: "/"` group PR. Its diff touches `ui/package.json` AND
 * `pnpm-lock.yaml` (the `ui:` importer block included), and the 25 packages bumped by
 * the `/ui` PR #1197 are a strict SUBSET of the 26 it bumps in that same file. The root
 * entry already covers the ui workspace; the `/ui` entry was redundant as well as
 * broken.
 *
 * Upstream says the same thing in so many words. dependabot-core PR #11487, merged
 * 2025-02-05 ("Handle Misconfigured Dependabot for PNPM Workspaces"), names the exact
 * shape — a root entry plus subdirectory entries — as the misconfiguration, and states:
 * "If you are using PNPM workspaces, you should only define the root directory (`/`) in
 * `dependabot.yml`. Dependabot will automatically update dependencies across all
 * workspaces from there." The symptom is dependabot-core issue #11135.
 *
 * ## What this module checks
 *
 * The rule is upstream's, restated against the filesystem: an npm entry whose directory
 * does not own a lockfile, but whose ANCESTOR does, is updating manifests it cannot
 * relock. Everything here is pure and takes file *text* plus a set of lockfile
 * directories, so the sibling unit test can construct states that are awkward on disk.
 *
 * It also holds the #586 cooldown floor. That is not scope creep: the floor lives in the
 * same file this guard parses, and a restructuring edit is precisely the moment a
 * `default-days` would go missing unnoticed. `shouldRunAdversarialPass` agrees the file
 * is security-relevant — measured, `{changedPaths: [".github/dependabot.yml"]}` returns
 * `required: true` with the reason "a security or verification gate — weakening one
 * reports green afterwards". Note that reason comes from the #1249 **gate-word** arm
 * (`adversarial-tally-core.mjs`), not from `PATH_SIGNALS`; #1283's panel read only the
 * latter and concluded the opposite, so check both arms before repeating that.
 */

import { existsSync as nodeExistsSync } from "node:fs";

/** Thrown when the config cannot be understood. Never returned as a "no problems" pass. */
export class DependabotConfigParseError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "DependabotConfigParseError";
  }
}

/**
 * @typedef {{indent: number, text: string, lineNumber: number}} ConfigLine
 * @typedef {{value: string|null, children: ConfigLine[], lineNumber: number}} ConfigField
 * @typedef {Map<string, ConfigField>} ConfigFields
 */

/**
 * Default cooldown floor in days (#586). Mirrors `minimumReleaseAge: 10080` (7 days) in
 * `pnpm-workspace.yaml`, so a compromised release has a window to be yanked before
 * Dependabot will propose it.
 */
export const COOLDOWN_FLOOR_DAYS = 7;

/**
 * Normalise a Dependabot `directory` value to a repo-relative POSIX path, with the
 * repository root as the empty string.
 *
 * Fails closed on a relative path or a glob rather than guessing: either would quietly
 * change which directories the audit below compares against.
 *
 * @param {string} value
 * @returns {string}
 */
export function normalizeDirectory(value) {
  if (typeof value !== "string") {
    throw new DependabotConfigParseError(
      `directory must be a string, got ${value === null ? "null" : typeof value}`,
    );
  }
  const trimmed = value.trim();
  if (trimmed.includes("*") || trimmed.includes("?")) {
    throw new DependabotConfigParseError(
      `directory "${trimmed}" is a glob; this guard understands only literal paths`,
    );
  }
  if (!trimmed.startsWith("/")) {
    throw new DependabotConfigParseError(
      `directory "${trimmed}" must start with "/" — Dependabot resolves it from the repository root`,
    );
  }
  return trimmed.replace(/^\/+/, "").replace(/\/+$/, "");
}

/**
 * Remove an unquoted trailing `#` comment. Quoted `#` characters survive.
 *
 * @param {string} line
 * @returns {string}
 */
function stripComment(line) {
  let out = "";
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      out += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === "#" && (i === 0 || /\s/.test(line[i - 1]))) break;
    out += ch;
  }
  return out.replace(/\s+$/, "");
}

/**
 * Strip one layer of matching surrounding quotes.
 *
 * @param {string} value
 * @returns {string}
 */
function unquote(value) {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && (trimmed[0] === '"' || trimmed[0] === "'")) {
    if (trimmed[trimmed.length - 1] === trimmed[0]) return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Parse an inline flow sequence: `["/a", "/b"]`.
 *
 * @param {string} value
 * @returns {string[]}
 */
function parseFlowSequence(value) {
  const inner = value.trim().slice(1, -1).trim();
  if (inner === "") return [];
  return inner.split(",").map((/** @type {string} */ part) => unquote(part));
}

/**
 * Parse the `updates:` list of a `dependabot.yml`.
 *
 * This is a deliberately small, shape-specific reader rather than a YAML dependency:
 * `scripts` declares no YAML parser (`scripts/package.json`), and its sibling
 * `pnpm-overrides-core.mjs` reads `pnpm-workspace.yaml` the same way. Anything it does
 * not recognise throws.
 *
 * @param {string} text
 * @returns {Array<{ecosystem: string, directories: string[], cooldownDays: number|null,
 *   groups: string[], lineNumber: number, raw: Record<string, string|null>}>}
 */
export function parseDependabotUpdates(text) {
  if (typeof text !== "string") {
    throw new DependabotConfigParseError(`dependabot config must be a string, got ${typeof text}`);
  }
  const lines = text.split(/\r?\n/).map(stripComment);
  const start = lines.findIndex((line) => /^updates:\s*$/.test(line));
  if (start < 0) {
    throw new DependabotConfigParseError("no top-level `updates:` block found");
  }

  /** @type {ConfigLine[]} */
  const block = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === "") continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0) break;
    block.push({ indent, text: line.trim(), lineNumber: i + 1 });
  }
  if (block.length === 0) {
    throw new DependabotConfigParseError("the `updates:` block is empty");
  }

  /** @type {ConfigLine[][]} */
  const rawEntries = [];
  // A new update entry is a `- ` at the FIRST list item's own indent. A `- ` deeper than
  // that is a nested sequence item (`directories:`), not a new ecosystem — reading it as
  // one silently split every block-list config into bogus entries.
  const entryIndent = block[0].indent;
  for (const item of block) {
    if (item.text.startsWith("- ") && item.indent === entryIndent) {
      rawEntries.push([
        { indent: item.indent + 2, text: item.text.slice(2).trim(), lineNumber: item.lineNumber },
      ]);
    } else {
      if (rawEntries.length === 0) {
        throw new DependabotConfigParseError(
          `line ${item.lineNumber}: content appears before the first \`- \` list item`,
        );
      }
      rawEntries[rawEntries.length - 1].push(item);
    }
  }

  return rawEntries.map(parseEntry);
}

/** @param {ConfigLine[]} entryLines */
function parseEntry(entryLines) {
  const bodyIndent = entryLines[0].indent;
  /** @type {ConfigFields} */
  const fields = new Map();
  /** @type {ConfigField|null} */
  let currentField = null;

  for (const line of entryLines) {
    if (line.indent === bodyIndent) {
      const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.text);
      if (!match) {
        throw new DependabotConfigParseError(
          `line ${line.lineNumber}: expected \`key: value\`, got ${JSON.stringify(line.text)}`,
        );
      }
      currentField = {
        value: match[2] === "" ? null : match[2],
        children: [],
        lineNumber: line.lineNumber,
      };
      fields.set(match[1], currentField);
    } else if (line.indent > bodyIndent) {
      // `currentField` is always set here: the first line of an entry sits at `bodyIndent`,
      // so the branch above has run at least once before any deeper line is seen.
      /** @type {ConfigField} */ (currentField).children.push(line);
    } else {
      throw new DependabotConfigParseError(
        `line ${line.lineNumber}: dedents out of the entry body`,
      );
    }
  }

  const lineNumber = entryLines[0].lineNumber;

  const ecosystemField = fields.get("package-ecosystem");
  if (!ecosystemField || ecosystemField.value === null) {
    throw new DependabotConfigParseError(
      `line ${lineNumber}: update entry has no \`package-ecosystem\``,
    );
  }
  const ecosystem = unquote(ecosystemField.value);

  const directories = readDirectories(fields, lineNumber);
  const cooldownDays = readCooldownDays(fields);
  const groups = readGroupNames(fields);

  /** @type {Record<string, string|null>} */
  const raw = {};
  for (const [key, field] of fields) raw[key] = field.value === null ? null : unquote(field.value);

  return { ecosystem, directories, cooldownDays, groups, lineNumber, raw };
}

/**
 * @param {ConfigFields} fields
 * @param {number} lineNumber
 * @returns {string[]}
 */
function readDirectories(fields, lineNumber) {
  const single = fields.get("directory");
  const many = fields.get("directories");
  if (single && many) {
    throw new DependabotConfigParseError(
      `line ${lineNumber}: update entry declares both \`directory\` and \`directories\``,
    );
  }
  if (single) {
    if (single.value === null) {
      throw new DependabotConfigParseError(`line ${lineNumber}: \`directory\` has no value`);
    }
    return [normalizeDirectory(unquote(single.value))];
  }
  if (many) {
    if (many.value !== null) {
      const flow = many.value.trim();
      if (!flow.startsWith("[") || !flow.endsWith("]")) {
        throw new DependabotConfigParseError(
          `line ${many.lineNumber}: \`directories\` must be a list`,
        );
      }
      return parseFlowSequence(flow).map(normalizeDirectory);
    }
    const items = many.children.map((child) => {
      if (!child.text.startsWith("- ")) {
        throw new DependabotConfigParseError(
          `line ${child.lineNumber}: expected a \`- \` list item under \`directories\``,
        );
      }
      return normalizeDirectory(unquote(child.text.slice(2)));
    });
    if (items.length === 0) {
      throw new DependabotConfigParseError(`line ${many.lineNumber}: \`directories\` is empty`);
    }
    return items;
  }
  throw new DependabotConfigParseError(
    `line ${lineNumber}: update entry declares neither \`directory\` nor \`directories\``,
  );
}

/**
 * @param {ConfigFields} fields
 * @returns {number|null}
 */
function readCooldownDays(fields) {
  const cooldown = fields.get("cooldown");
  if (!cooldown) return null;
  const childIndent = Math.min(...cooldown.children.map((c) => c.indent));
  for (const child of cooldown.children) {
    if (child.indent !== childIndent) continue;
    const match = /^default-days:\s*(.+)$/.exec(child.text);
    if (!match) continue;
    const value = unquote(match[1]);
    if (!/^\d+$/.test(value)) {
      throw new DependabotConfigParseError(
        `line ${child.lineNumber}: \`default-days\` must be a whole number, got ${JSON.stringify(value)}`,
      );
    }
    return Number(value);
  }
  return null;
}

/**
 * @param {ConfigFields} fields
 * @returns {string[]}
 */
function readGroupNames(fields) {
  const groups = fields.get("groups");
  if (!groups || groups.children.length === 0) return [];
  const childIndent = Math.min(...groups.children.map((c) => c.indent));
  return groups.children
    .filter((child) => child.indent === childIndent)
    .map((child) => {
      const match = /^([A-Za-z0-9_.-]+):\s*$/.exec(child.text);
      if (!match) {
        throw new DependabotConfigParseError(
          `line ${child.lineNumber}: expected a group name, got ${JSON.stringify(child.text)}`,
        );
      }
      return match[1];
    });
}

/**
 * Lockfile names any Dependabot npm-ecosystem update could regenerate in place.
 * `pnpm-lock.yaml` is the only one this repo has, deliberately (#1283).
 */
export const LOCKFILE_NAMES = Object.freeze([
  "pnpm-lock.yaml",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
]);

/**
 * Every ancestor of `dir`, nearest first, ending at the repository root (`""`).
 *
 * @param {string} dir
 * @returns {string[]}
 */
export function ancestorsOf(dir) {
  const out = [];
  let current = dir;
  while (current !== "") {
    const cut = current.lastIndexOf("/");
    current = cut === -1 ? "" : current.slice(0, cut);
    out.push(current);
  }
  return out;
}

/**
 * Which of `candidateDirs` actually hold a lockfile on disk.
 *
 * @param {string} rootDir
 * @param {Iterable<string>} candidateDirs Normalised repo-relative paths ("" = root).
 * @param {{existsSync?: (path: string) => boolean}} [io]
 * @returns {Set<string>}
 */
export function collectLockfileDirs(rootDir, candidateDirs, io = {}) {
  const existsSync = io.existsSync ?? nodeExistsSync;
  const found = new Set();
  for (const dir of candidateDirs) {
    const prefix = dir === "" ? rootDir : `${rootDir}/${dir}`;
    if (LOCKFILE_NAMES.some((name) => existsSync(`${prefix}/${name}`))) found.add(dir);
  }
  return found;
}

/**
 * Nearest ancestor directory of `dir` that holds a lockfile, or null.
 *
 * @param {string} dir
 * @param {Set<string>} lockfileDirs
 * @returns {string|null}
 */
function nearestAncestorWithLockfile(dir, lockfileDirs) {
  return ancestorsOf(dir).find((ancestor) => lockfileDirs.has(ancestor)) ?? null;
}

/**
 * Is `dir` matched by one of pnpm's `packages:` patterns (literal or trailing `/*`)?
 *
 * @param {string} dir
 * @param {string[]} workspacePackages
 * @returns {boolean}
 */
function isWorkspaceMember(dir, workspacePackages) {
  return workspacePackages.some((pattern) => {
    const clean = pattern.replace(/\/+$/, "");
    if (clean.endsWith("/*")) {
      const parent = clean.slice(0, -2);
      return dir.startsWith(`${parent}/`) && !dir.slice(parent.length + 1).includes("/");
    }
    return clean === dir;
  });
}

/**
 * Audit a `dependabot.yml` against where the repository's lockfiles actually live.
 *
 * @param {object} options
 * @param {string} options.dependabotText
 * @param {Set<string>} options.lockfileDirs Normalised directories holding a lockfile ("" = root).
 * @param {string[]} [options.workspacePackages] pnpm `packages:` patterns. LOAD-BEARING:
 *   an ancestor's lockfile only pins a subdirectory that is a workspace member, so this is
 *   what separates the #1283 defect from a legitimate standalone subproject.
 * @param {number} [options.cooldownFloorDays]
 */
export function auditDependabotWorkspaceScope({
  dependabotText,
  lockfileDirs,
  workspacePackages = [],
  cooldownFloorDays = COOLDOWN_FLOOR_DAYS,
}) {
  if (!(lockfileDirs instanceof Set)) {
    throw new TypeError("lockfileDirs must be a Set of normalised directory paths");
  }
  if (!Array.isArray(workspacePackages)) {
    throw new TypeError("workspacePackages must be an array of pnpm `packages:` patterns");
  }

  const entries = parseDependabotUpdates(dependabotText);
  const npmEntries = entries.filter((entry) => entry.ecosystem === "npm");
  const problems = [];

  let coveringDirectories = 0;
  for (const entry of npmEntries) {
    for (const directory of entry.directories) {
      if (lockfileDirs.has(directory)) {
        coveringDirectories += 1;
        continue;
      }
      const coveredBy = nearestAncestorWithLockfile(directory, lockfileDirs);
      const shown = directory === "" ? "/" : `/${directory}`;
      if (coveredBy === null) {
        problems.push({
          kind: "npm-directory-has-no-lockfile",
          ecosystem: entry.ecosystem,
          directory,
          lineNumber: entry.lineNumber,
          message:
            `npm ecosystem at \`${shown}\` (line ${entry.lineNumber}) has no lockfile at or ` +
            `above it, so Dependabot has nothing to relock there`,
        });
        continue;
      }

      // MEMBERSHIP IS THE WHOLE TEST, not "some ancestor has a lockfile". A root lockfile
      // pins a subdirectory only when pnpm treats that subdirectory as a workspace member;
      // for a standalone subproject like images/mcp-wrappers/* — its own pinned deps, its
      // own `npm ci` in its own Dockerfile — the root lockfile says nothing about it, so
      // there is no staleness to cause and nothing here to report. Flagging those was an
      // over-reach caught by the #1283 adversarial panel, and it would have arrived with
      // the affirmatively false remedy "the root entry already relocks it".
      if (!isWorkspaceMember(directory, workspacePackages)) continue;

      const owner = coveredBy === "" ? "the repository root" : `/${coveredBy}`;
      problems.push({
        kind: "orphan-npm-directory",
        ecosystem: entry.ecosystem,
        directory,
        coveredBy,
        workspaceMember: true,
        lineNumber: entry.lineNumber,
        message:
          `npm ecosystem at \`${shown}\` (line ${entry.lineNumber}) is a pnpm workspace ` +
          `member that owns no lockfile — the one that pins it lives at ${owner}. ` +
          `Dependabot will rewrite the manifest and leave that lockfile stale, so ` +
          `\`pnpm install --frozen-lockfile\` fails with ERR_PNPM_OUTDATED_LOCKFILE ` +
          `(#1283). Delete this entry; the entry rooted at ${owner} already bumps this ` +
          `directory's manifest and relocks it.`,
      });
    }
  }

  // Fail closed on the membership test itself. With an empty `workspacePackages` every
  // directory reads as a standalone subproject and the check above skips silently — the
  // #1168 shape, where the default means "nothing to check". A subdirectory npm entry
  // cannot be judged without the workspace list, so refuse rather than pass.
  const subdirectoryNpmDirs = npmEntries.flatMap((entry) =>
    entry.directories.filter((directory) => directory !== "" && !lockfileDirs.has(directory)),
  );
  if (subdirectoryNpmDirs.length > 0 && workspacePackages.length === 0) {
    throw new TypeError(
      "workspacePackages is empty but npm entries target subdirectories " +
        `(${subdirectoryNpmDirs.join(", ")}); workspace membership decides whether an ` +
        "ancestor lockfile pins them, so the audit cannot be evaluated without it",
    );
  }

  if (npmEntries.length === 0) {
    problems.push({
      kind: "no-npm-ecosystem",
      message:
        "no npm ecosystem is declared at all — the JavaScript dependency tree would receive " +
        "no version updates, and this guard would otherwise pass vacuously",
    });
  } else if (coveringDirectories === 0) {
    problems.push({
      kind: "no-covering-npm-entry",
      message:
        "no npm ecosystem entry sits on a directory that owns a lockfile, so no update can " +
        "ever produce a consistent tree",
    });
  }

  for (const entry of entries) {
    const shown = entry.directories.map((d) => (d === "" ? "/" : `/${d}`)).join(", ");
    if (entry.cooldownDays === null) {
      problems.push({
        kind: "cooldown-missing",
        ecosystem: entry.ecosystem,
        lineNumber: entry.lineNumber,
        cooldownDays: null,
        message:
          `${entry.ecosystem} entry at ${shown} (line ${entry.lineNumber}) declares no ` +
          `\`cooldown.default-days\`; #586 requires at least ${cooldownFloorDays} so a ` +
          `compromised release has a window to be yanked`,
      });
    } else if (entry.cooldownDays < cooldownFloorDays) {
      problems.push({
        kind: "cooldown-below-floor",
        ecosystem: entry.ecosystem,
        lineNumber: entry.lineNumber,
        cooldownDays: entry.cooldownDays,
        message:
          `${entry.ecosystem} entry at ${shown} (line ${entry.lineNumber}) sets ` +
          `\`cooldown.default-days: ${entry.cooldownDays}\`, below the #586 floor of ` +
          `${cooldownFloorDays} (mirrors \`minimumReleaseAge: 10080\`)`,
      });
    }
  }

  return { problems, entries, npmEntries };
}
