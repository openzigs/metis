/**
 * Pure decision logic for the **Copilot** agent surface, `.github/agents/*.agent.md`
 * (Issue #1282).
 *
 * ## Why this exists
 *
 * METIS ships two agent-definition directories and `agents:verify` read one of them.
 * `.github/agents/` is GitHub's documented custom-agent convention, consumed by the
 * Copilot coding agent, Copilot CLI and the IDEs — an **external** reader that this
 * repository cannot observe. That is precisely why it drifted four days behind its
 * `.claude/agents/` twins without anyone noticing: a stale Claude agent breaks a session
 * someone is watching, a stale Copilot agent breaks a session in a browser tab that never
 * reports back here. There is no local failure mode, so there has to be a gate.
 *
 * The full reasoning, the options rejected, and the boundary of what a gate can honestly
 * assert live in `docs/decisions/0009-two-agent-surfaces-one-gate.md`. In short: the two
 * surfaces are **not** copies and cannot be generated from one another — disjoint
 * frontmatter schemas, opposite MCP truth (a Claude subagent with a `tools:` allowlist has
 * zero MCP tools and #1180 *fails* an `mcp__*` instruction to it, while Copilot agents hold
 * `github/*`), and legitimately different rosters. What they do share, and what this module
 * checks, is runtime-independent structure:
 *
 *  1. **Frontmatter validity** — closed fence, `name` whose slug is the filename, a
 *     `description` that exists, clears the floor, and was not silently eaten by YAML's
 *     ` #` inline-comment rule (#1142's defect, one parser for both surfaces).
 *  2. **The reference graph resolves** — `agents:` entries and `handoffs[].agent` must name
 *     an agent file that exists. This is #1146's exact class: an agent was deleted and a
 *     dangling reference to it survived in another agent's body. Six such edges exist in
 *     `.github/agents/` today and nothing checked them.
 *  3. **Roster parity between the two directories**, with exemptions that must be written
 *     down and that expire on their own.
 *
 * What it deliberately does **not** check is prose parity between twins. The bodies are
 * different documents for different runtimes and must be; a similarity check would be
 * either trivially satisfiable or impossible, and this repo has shipped fifteen gates that
 * could not fail (#1215, #1249, #1270, #1277). The residual risk — a twin going stale in
 * its *content*, as `adversarial-reviewer.agent.md` did — is stated in the ADR rather than
 * pretended away.
 *
 * Everything here is pure: callers inject file contents, so every branch is unit-testable
 * without a repository.
 */

import { MIN_DESCRIPTION_LENGTH, parseFrontmatter } from "./skill-links-core.mjs";

/** Directory GitHub Copilot scans for repository custom agents. */
export const COPILOT_AGENT_DIR = ".github/agents";

/** Suffix that makes a file in that directory an agent definition. */
export const COPILOT_AGENT_SUFFIX = ".agent.md";

/** Directory Claude Code scans for project subagents. */
export const CLAUDE_AGENT_DIR = ".claude/agents";

/**
 * The two surfaces, as the *only* place their identity is written down.
 *
 * The marker vocabulary below is derived from these keys rather than listed beside them,
 * so renaming a surface cannot leave a marker token pointing at nothing — the #1249 shape,
 * where a manifest built from its own vocabulary had 18 of 19 entries deletable with the
 * suite still green.
 *
 * @type {Record<"copilot" | "claude", { dir: string, label: string, filename: (slug: string) => string }>}
 */
export const SURFACES = {
  copilot: {
    dir: COPILOT_AGENT_DIR,
    label: "Copilot",
    filename: (slug) => `${slug}${COPILOT_AGENT_SUFFIX}`,
  },
  claude: {
    dir: CLAUDE_AGENT_DIR,
    label: "Claude Code",
    filename: (slug) => `${slug}.md`,
  },
};

/** The surface tokens a `<!-- surface: ... -->` marker may name, e.g. `copilot-only`. */
export const SURFACE_TOKENS = Object.keys(SURFACES).map((key) => `${key}-only`);

/**
 * The exemption marker.
 *
 * An HTML comment because it has to be invisible in both renderers and inert to both
 * runtimes, and because a *frontmatter* key would have to be legal in two disjoint
 * schemas. The separator is permissive (em dash, en dash, hyphen or colon) because the
 * repo's prose uses em dashes and a gate that fails on punctuation is a gate people route
 * around.
 *
 * The justification is `[\s\S]*?`, not `[^>]*?`. A reviewer on #1282 demonstrated that the
 * character-class form makes a justification containing `>` — a comparison, a quoted shell
 * redirect, a `-->` in prose — fail to match at all, so the marker reads as *absent* and
 * the agent is reported as an unexplained orphan. Lazy-matching up to the first `-->`
 * stops at the same place for every well-formed comment and does not silently discard one.
 */
const SURFACE_MARKER_RE = /<!--\s*surface:\s*([a-z][a-z0-9-]*)\s*(?:[—–:-]\s*)?([\s\S]*?)\s*-->/i;

/**
 * A justification has to cite something durable — a GitHub issue or an ADR path.
 *
 * Without this the marker degrades into a rubber stamp: "not needed here" is exactly the
 * kind of exemption that outlives its reason, and the reason is the only thing that lets a
 * later reader decide whether it still holds. #1187's half-migration survived because the
 * duplicate carried no record of why it was a duplicate.
 */
const JUSTIFICATION_CITATION_RE = /(#\d+|docs\/decisions\/[\w.-]+)/;

/**
 * Slugify a Copilot display name into the kebab-case identity both surfaces share.
 *
 * `name: Adversarial Reviewer` in `.github/agents/adversarial-reviewer.agent.md` is the
 * same agent as `name: adversarial-reviewer` in `.claude/agents/adversarial-reviewer.md`.
 * The filename is the join key, and this is the one function that decides how a display
 * name maps onto it — the site-finder/checker split in #1192 is what happens when two
 * places normalise the same string differently.
 *
 * @param {string} name
 * @returns {string} kebab-case slug, or "" when the input carries no slug characters
 */
export function slugifyAgentName(name) {
  if (typeof name !== "string") return "";
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * The agent slug a `.github/agents/` filename denotes, or `null` when the entry is not an
 * agent definition at all.
 *
 * @param {string} filename
 * @returns {string | null}
 */
export function copilotAgentSlug(filename) {
  if (typeof filename !== "string") return null;
  if (!filename.endsWith(COPILOT_AGENT_SUFFIX)) return null;
  const slug = filename.slice(0, -COPILOT_AGENT_SUFFIX.length);
  return slug.length > 0 ? slug : null;
}

/**
 * Every agent this file hands off to or spawns.
 *
 * Two shapes, both present in `.github/agents/` today:
 *
 * ```yaml
 * agents:
 *   - Adversarial Reviewer      # a block sequence of display names
 * handoffs:
 *   - label: Start Implementation
 *     agent: Code Issue         # an `agent:` key nested inside a list of maps
 * ```
 *
 * `parseBlockLists` in `agent-frontmatter-core.mjs` handles the first and **not** the
 * second: it clears its current key on any indented `key: value` line, so only a handoff
 * whose `agent:` happens to be its first field would ever be seen. Rather than widen a
 * parser three other rules depend on, this reads the frontmatter block directly for both
 * shapes. It is deliberately indentation-agnostic — an `agent:` key anywhere in the
 * frontmatter is a reference, and there is no other field by that name in either schema.
 *
 * @param {string} text full file contents
 * @returns {string[]} display names, in file order, deduplicated
 */
export function parseAgentReferences(text) {
  /** @type {string[]} */
  const names = [];
  if (typeof text !== "string") return names;

  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return names;

  let inAgentsList = false;
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === "---") break;

    // A nested `agent:` scalar — the `handoffs[]` shape.
    const handoff = /^\s*(?:-\s*)?agent:\s*(.+?)\s*$/.exec(line);
    if (handoff) {
      const value = scalarValue(handoff[1]);
      if (value.length > 0 && !names.includes(value)) names.push(value);
      inAgentsList = false;
      continue;
    }

    if (/^agents:\s*$/.test(line)) {
      inAgentsList = true;
      continue;
    }

    // Inline flow sequence: `agents: [Research, Code Issue]`.
    const inline = /^agents:\s*\[(.*)\]\s*$/.exec(line);
    if (inline) {
      for (const part of inline[1].split(",")) {
        const value = scalarValue(part.trim());
        if (value.length > 0 && !names.includes(value)) names.push(value);
      }
      inAgentsList = false;
      continue;
    }

    if (inAgentsList) {
      const item = /^\s+-\s*(.+?)\s*$/.exec(line);
      if (item) {
        const value = scalarValue(item[1]);
        if (value.length > 0 && !names.includes(value)) names.push(value);
        continue;
      }
      // Any non-item line at this point closes the block sequence.
      if (line.trim().length > 0) inAgentsList = false;
    }
  }

  return names;
}

/**
 * Resolve one YAML scalar the way YAML itself does: strip a matched quote pair, and in an
 * **unquoted** scalar drop everything from a ` #` inline comment onward.
 *
 * The comment half is not decoration. A reviewer on #1282 demonstrated the failure: an
 * `agents:` item written `- Code Issue # the implementer` is valid YAML that Copilot reads
 * as `Code Issue`, and without this the reference resolved as `code-issue-the-implementer`
 * and was reported as a dangling reference to an agent that does exist. That is a gate
 * rejecting a legitimate file, with a message pointing at the wrong defect — the
 * over-blocking failure, and the module's own JSDoc happened to write the offending shape.
 *
 * It is the same rule `parseFrontmatter` applies to top-level scalars, restated here rather
 * than shared because that parser deliberately never descends into block sequences.
 *
 * @param {string} value
 * @returns {string}
 */
function scalarValue(value) {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  const comment = value.indexOf(" #");
  return (comment >= 0 ? value.slice(0, comment) : value).trim();
}

/**
 * Parse a surface-exemption marker out of a file.
 *
 * Returns `null` when there is no marker at all — which is a different state from a marker
 * that is malformed, and the caller must treat them differently: absent means "no exemption
 * claimed", malformed means "an exemption was claimed and cannot be read", and the second
 * has to fail rather than fall through to the first. Collapsing the two is the fail-open
 * shape #1215 found eight times.
 *
 * @param {string | null | undefined} text
 * @returns {{ token: string, surface: string | null, justification: string } | null}
 */
export function parseSurfaceMarker(text) {
  if (typeof text !== "string") return null;
  const match = SURFACE_MARKER_RE.exec(text);
  if (match === null) return null;
  const token = match[1].toLowerCase();
  const surface = SURFACE_TOKENS.includes(token) ? token.replace(/-only$/, "") : null;
  return { token, surface, justification: match[2].trim() };
}

/**
 * Validate one `.github/agents/<slug>.agent.md`.
 *
 * @param {object} input
 * @param {string} input.slug filename slug, e.g. "code-review"
 * @param {string | null} input.text file contents, or null when unreadable
 * @param {string[]} input.knownSlugs every slug present in `.github/agents/`
 * @returns {string[]} problems
 */
export function checkCopilotAgent({ slug, text, knownSlugs = [] }) {
  /** @type {string[]} */
  const problems = [];
  const filePath = `${COPILOT_AGENT_DIR}/${SURFACES.copilot.filename(slug)}`;

  // An unreadable file is UNKNOWN, never clean (#1215). Copilot will still load whatever
  // is on disk; the gate simply cannot say what that is, and "cannot say" must not read
  // as "fine".
  if (typeof text !== "string") {
    problems.push(`${filePath} is missing or unreadable — cannot verify it.`);
    return problems;
  }

  const { found, fields, commentTruncated } = parseFrontmatter(text);
  if (!found) {
    problems.push(
      `${filePath} has no closed --- frontmatter block, so Copilot loads it with no name, ` +
        `description or tool list.`,
    );
    return problems;
  }

  // --- name ↔ filename -------------------------------------------------------
  const declared = fields.name ?? "";
  if (declared.length === 0) {
    problems.push(`${filePath}: frontmatter is missing "name".`);
  } else {
    const declaredSlug = slugifyAgentName(declared);
    if (declaredSlug !== slug) {
      problems.push(
        `${filePath}: frontmatter name "${declared}" slugifies to "${declaredSlug}", but the ` +
          `file is "${SURFACES.copilot.filename(slug)}". The filename is the join key between ` +
          `the two agent surfaces, so a mismatch silently splits one agent into two.`,
      );
    }
  }

  // --- description -----------------------------------------------------------
  if (commentTruncated.includes("description")) {
    problems.push(
      `${filePath}: the description is unquoted and contains " #", so YAML discards everything ` +
        `from the hash onward. Wrap the value in quotes (#1142).`,
    );
  }
  const description = fields.description ?? "";
  if (description.length === 0) {
    problems.push(`${filePath}: frontmatter is missing "description".`);
  } else if (description.length < MIN_DESCRIPTION_LENGTH) {
    problems.push(
      `${filePath}: description is ${description.length} chars — under the ` +
        `${MIN_DESCRIPTION_LENGTH}-char floor. Copilot routes to a custom agent on the ` +
        `description alone, so a title-shaped one either never fires or fires on everything.`,
    );
  }

  // --- the reference graph resolves (#1146's class) ---------------------------
  for (const reference of parseAgentReferences(text)) {
    const target = slugifyAgentName(reference);
    if (target.length === 0) {
      problems.push(`${filePath}: names an agent "${reference}" that slugifies to nothing.`);
      continue;
    }
    if (target === slug) {
      problems.push(
        `${filePath}: names itself ("${reference}") in agents:/handoffs:, which cannot resolve ` +
          `to a subagent.`,
      );
      continue;
    }
    if (!knownSlugs.includes(target)) {
      problems.push(
        `${filePath}: names agent "${reference}", but ` +
          `${COPILOT_AGENT_DIR}/${SURFACES.copilot.filename(target)} does not exist. Either the ` +
          `agent was renamed and this reference was not, or it was deleted and this is the ` +
          `dangling half (#1146).`,
      );
    }
  }

  return problems;
}

/**
 * Assert that the two agent directories name the same set, or that each difference is
 * written down.
 *
 * ## Why parity and not generation
 *
 * See ADR 0009. The short version is that the surfaces are translations for runtimes with
 * opposite tool models, not copies, so the *text* cannot be shared — but the **roster** can,
 * and roster drift is the kind that compounds: an agent added to one surface and not the
 * other is invisible to half the fleet forever.
 *
 * ## Why an exemption expires on its own
 *
 * A marker on a file whose twin **does** exist is a failure, not a no-op. That is #1187's
 * lesson stated mechanically: a duplicated instruction hides a half-migration, and the fix
 * is to grep the old name. An exemption that stays valid after its condition ends is an
 * exemption nobody will ever remove, and the next reader has no way to tell a live one from
 * a fossil.
 *
 * ## Fail-closed
 *
 * Every difference needs a marker, the marker's surface must be the one the file is on, and
 * the justification must cite an issue or an ADR. An unrecognised surface token fails rather
 * than being ignored — a typo'd `<!-- surface: copilot -->` that silently granted the
 * exemption would be the gate-that-cannot-fail shape again.
 *
 * @param {object} input
 * @param {Record<string, string | null>} input.copilotFiles contents keyed by slug
 * @param {Record<string, string | null>} input.claudeFiles contents keyed by agent name
 * @returns {string[]} problems
 */
export function checkRosterParity({ copilotFiles = {}, claudeFiles = {} }) {
  /** @type {string[]} */
  const problems = [];
  const copilotSlugs = Object.keys(copilotFiles);
  const claudeSlugs = Object.keys(claudeFiles);
  const union = [...new Set([...copilotSlugs, ...claudeSlugs])].sort();

  for (const slug of union) {
    const onCopilot = Object.prototype.hasOwnProperty.call(copilotFiles, slug);
    const onClaude = Object.prototype.hasOwnProperty.call(claudeFiles, slug);
    const present = onCopilot ? "copilot" : "claude";
    const missing = onCopilot ? "claude" : "copilot";
    const text = onCopilot ? copilotFiles[slug] : claudeFiles[slug];
    const presentPath = `${SURFACES[present].dir}/${SURFACES[present].filename(slug)}`;
    const marker = parseSurfaceMarker(text);

    if (onCopilot && onClaude) {
      // Both present: any marker on either file is a fossil.
      for (const surface of /** @type {const} */ (["copilot", "claude"])) {
        const files = surface === "copilot" ? copilotFiles : claudeFiles;
        const stale = parseSurfaceMarker(files[slug]);
        if (stale === null) continue;
        problems.push(
          `${SURFACES[surface].dir}/${SURFACES[surface].filename(slug)} carries a ` +
            `"surface: ${stale.token}" exemption, but "${slug}" exists on BOTH surfaces. The ` +
            `exemption is stale — delete it, or the next reader cannot tell a live exemption ` +
            `from a fossil (#1187).`,
        );
      }
      continue;
    }

    const missingPath = `${SURFACES[missing].dir}/${SURFACES[missing].filename(slug)}`;

    if (marker === null) {
      problems.push(
        `"${slug}" exists at ${presentPath} but ${missingPath} does not. Add the twin, or ` +
          `record why not with an HTML comment in ${presentPath}: ` +
          `<!-- surface: ${present}-only — <reason citing #NNNN or docs/decisions/...> -->`,
      );
      continue;
    }

    if (marker.surface === null) {
      problems.push(
        `${presentPath} claims "surface: ${marker.token}", which is not one of ` +
          `${SURFACE_TOKENS.join(", ")}. An unreadable exemption is not an exemption.`,
      );
      continue;
    }

    if (marker.surface !== present) {
      problems.push(
        `${presentPath} claims "surface: ${marker.token}", but the file is on the ` +
          `${SURFACES[present].label} surface. The marker names the surface the agent is ` +
          `KEPT on, not the one it is absent from.`,
      );
      continue;
    }

    if (!JUSTIFICATION_CITATION_RE.test(marker.justification)) {
      problems.push(
        `${presentPath} claims "surface: ${marker.token}" with justification ` +
          `"${marker.justification}", which cites no issue (#NNNN) or ADR ` +
          `(docs/decisions/...). An exemption with no recorded reason outlives its reason.`,
      );
    }
  }

  return problems;
}

/**
 * Does this document tell a reader the Copilot agent surface exists?
 *
 * **Two spellings, because the repository uses two.** `AGENTS.md` and
 * `.github/copilot-instructions.md` write the directory path; the six SKILL.md files that
 * name an agent write only the bare filename — *"Execute with the Code Review agent
 * (`code-review.agent.md`)"*. A reviewer on #1282 measured that a path-only predicate
 * matched exactly **one** of the seven skill references, which made the runner's whole
 * skill-gathering loop near-inert: the hole it was added to close would have stayed open
 * for the documents most likely to dangle.
 *
 * @param {string | null | undefined} text
 * @returns {boolean}
 */
export function documentClaimsCopilotSurface(text) {
  if (typeof text !== "string") return false;
  if (text.includes(`${COPILOT_AGENT_DIR}/`)) return true;
  // A literal, not `new RegExp(COPILOT_AGENT_SUFFIX)`: Semgrep's non-literal-regexp rule
  // blocks a pattern built from a variable, and the constant it would interpolate is one
  // line above anyway. `AGENT_FILENAME_RE` is asserted against the constant in the tests.
  return AGENT_FILENAME_RE.test(text);
}

/** `<slug>.agent.md` as written in prose. Pinned against `COPILOT_AGENT_SUFFIX` by test. */
const AGENT_FILENAME_RE = /\b[a-z0-9][a-z0-9-]*\.agent\.md\b/i;

/**
 * Assert that a repository whose documentation *promises* a Copilot surface actually has
 * one.
 *
 * ## The hole this closes
 *
 * `verifyCopilotSurface` is inert when `copilotFiles` is empty, and it has to be: a
 * repository with no `.github/agents/` at all is a legitimate tree, and `checkRosterParity`
 * firing once per Claude agent there would reject it. But "inert when the subject is
 * absent" is one `rm -rf` away from being a gate that cannot fail — delete the whole
 * directory and every rule in this module goes quiet, which is #1215's shape and the exact
 * objection `checkPanelWorktreeIsolation` had to answer for the same reason.
 *
 * It is closed the same way that rule closed it: by pinning the set to a **second source
 * of truth**, so removing the surface is a multi-file change that fails the moment either
 * half lands alone. `checkClaudeMdTable` pins `.claude/agents/` to `CLAUDE.md`'s table;
 * this pins `.github/agents/` to the documents that tell a reader it exists — `AGENTS.md`,
 * `.github/copilot-instructions.md` and the SKILL.md files that name `.agent.md` paths.
 *
 * @param {object} input
 * @param {Record<string, string | null>} input.copilotFiles contents keyed by slug
 * @param {Record<string, string | null>} [input.surfaceDocs] documents that may reference
 *   the directory, keyed by repo-relative path
 * @returns {string[]} problems
 */
export function checkSurfaceDocumented({ copilotFiles = {}, surfaceDocs = {} }) {
  /** @type {string[]} */
  const problems = [];
  if (Object.keys(copilotFiles).length > 0) return problems;

  const claiming = Object.keys(surfaceDocs).filter((docPath) =>
    documentClaimsCopilotSurface(surfaceDocs[docPath]),
  );
  claiming.sort();
  if (claiming.length === 0) return problems;

  problems.push(
    `${COPILOT_AGENT_DIR}/ holds no ${COPILOT_AGENT_SUFFIX} definition, but ` +
      `${claiming.join(", ")} still tell a reader it does. Every rule over the Copilot ` +
      `surface goes silent on an empty directory, so an undocumented removal reads exactly ` +
      `like a clean run (#1215). Delete the references too, or restore the definitions ` +
      `(#1282, docs/decisions/0009-two-agent-surfaces-one-gate.md).`,
  );
  return problems;
}

/**
 * Run the whole Copilot-surface check over pre-gathered inputs.
 *
 * The per-file and parity rules are **skipped entirely** when no Copilot definition was
 * gathered — see `checkSurfaceDocumented` for why that is not the fail-open it looks like,
 * and for what closes it.
 *
 * @param {object} input
 * @param {Record<string, string | null>} [input.copilotFiles] contents keyed by slug
 * @param {Record<string, string | null>} [input.claudeFiles] contents keyed by agent name
 * @param {Record<string, string | null>} [input.surfaceDocs] documents that reference the
 *   directory, keyed by repo-relative path
 * @returns {{ problems: string[] }}
 */
export function verifyCopilotSurface({ copilotFiles = {}, claudeFiles = {}, surfaceDocs = {} }) {
  /** @type {string[]} */
  const problems = [];
  const knownSlugs = Object.keys(copilotFiles).sort();

  problems.push(...checkSurfaceDocumented({ copilotFiles, surfaceDocs }));
  if (knownSlugs.length === 0) return { problems };

  for (const slug of knownSlugs) {
    problems.push(...checkCopilotAgent({ slug, text: copilotFiles[slug], knownSlugs }));
  }

  problems.push(...checkRosterParity({ copilotFiles, claudeFiles }));

  return { problems };
}
