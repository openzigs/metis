/**
 * #1064 — the "Related code" section of an issue draft.
 *
 * A requirement's code links (`RequirementCodeMapping`) were shown on its
 * traceability panel and nowhere in the issue a developer receives. This module
 * renders the links that are ALREADY PERSISTED for the requirement, in this
 * project: it never derives, re-ranks or filters them, so whatever rule decided
 * which links exist (and "no link" is one of its outcomes) is the only rule.
 *
 * Paths and symbol names come from an ingested repository, so they are
 * untrusted text going into a Markdown body that GitHub renders:
 *   - each is written inside an inline code span, where neither HTML nor
 *     Markdown is interpreted, with a fence longer than any backtick run in it;
 *   - control characters and line separators (a line break would end the
 *     span) become spaces, and invisible format characters (zero-width, bidi
 *     overrides) are dropped;
 *   - an HTML comment opener or closer is broken up (`<!- -`, `- ->`, `- -!>`:
 *     HTML5 ends a comment at `--!>` too), so the text can never be, open or
 *     close a comment — a METIS marker included;
 *   - a link is written only to the project's own repository, on an https
 *     origin, at a known ref, for a plain repository-relative path, with every
 *     segment URL-encoded, and never for a row whose path or symbol holds a
 *     square bracket (`[` + a path holding `]:` is a link reference definition,
 *     not a link). Otherwise the path stays text.
 * The link rules mirror `ui/src/lib/code-citation-blob-url.ts` (#728), which
 * the server cannot import.
 *
 * WHICH ISSUES GET LINKS. Only an issue published into the repository the code
 * was analysed from: same host, owner and name (`publishTargetBase`), decided
 * when the drafts are generated. A draft generated for any other target, or
 * for a target whose host the caller did not give, lists the same paths and
 * symbols as plain code — no URL, no owner or repository name, no commit SHA —
 * and says so: the analysed repository's coordinates are not written into
 * someone else's tracker. `assertCodeLinksMatchTarget` holds a batch to the
 * same rule if it is later pointed somewhere else, and a Jira issue always
 * gets the plain form (`bodyWithCodeAsText`): a Jira project is never the
 * analysed repository.
 *
 * WHICH HOSTS GET LINKS (`githubWebOrigin`), from the connector's API base URL:
 *   - none set, provider `github`            → `https://github.com`
 *   - `https://api.github.com`               → `https://github.com`
 *   - `https://api.<tenant>.ghe.com`         → `https://<tenant>.ghe.com`
 *     (GitHub Enterprise Cloud with data residency: the API has its own host)
 *   - any other https host (GitHub Enterprise Server, API under `/api/v3`)
 *                                            → that host's origin
 *   - not https, not a URL, or none set for an Enterprise connector → no link.
 */
import { prisma } from "../prisma.js";
import { createChildLogger } from "../logger.js";
import { PublishError } from "./types.js";

const log = createChildLogger("draft-code-links");

/** The most code links one issue body lists; the rest are counted, not shown. */
export const MAX_DRAFT_CODE_LINKS = 10;

/** The longest path or symbol name written; longer ones are cut with an ellipsis. */
const MAX_CODE_TEXT = 200;

export interface DraftCodeLink {
  filePath: string;
  startLine: number | null;
  endLine: number | null;
  symbolName: string | null;
  symbolKind: string | null;
}

/** Where the project's code is browsable: origin + owner/repo at a ref. */
export interface CodeLinkRepo {
  /** `https://github.com` or a GitHub Enterprise https origin. */
  origin: string;
  owner: string;
  repo: string;
  /** The ingested commit SHA when known, else the connector's branch. */
  ref: string;
}

export interface CodeLinkRepoSource {
  provider: string;
  ownerOrOrg: string | null;
  repoName: string | null;
  defaultBranch: string | null;
  apiBaseUrl: string | null;
  lastCommitSha: string | null;
}

const GITHUB_ORIGIN = "https://github.com";
const SHA_RE = /^[0-9a-f]{7,64}$/i;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._\-/]*$/;
/** Control characters, plus the Unicode line and paragraph separators. */
const CONTROL_RE = /[\u0000-\u001f\u007f\u0085\u2028\u2029]/;
const CONTROL_RE_GLOBAL = /[\u0000-\u001f\u007f\u0085\u2028\u2029]/g;
/** Invisible format characters: soft hyphen, zero-width, bidi marks and overrides, BOM. */
const INVISIBLE_RE_GLOBAL =
  /\u00ad|\u061c|\u180e|[\u200b-\u200f]|[\u202a-\u202e]|[\u2060-\u206f]|\ufeff/g;
/** The API host of a GitHub Enterprise Cloud tenant with data residency. */
const GHE_CLOUD_API_HOST_RE = /^api\.([a-z0-9][a-z0-9-]*\.ghe\.com)$/;
const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const KIND_RE = /^[a-z][a-z_-]{0,19}$/;

/** The web origin code is browsed on, for a connector or a publish target. */
export function githubWebOrigin(provider: string, apiBaseUrl: string | null): string | null {
  if (!apiBaseUrl) return provider === "github" ? GITHUB_ORIGIN : null;
  let parsed: URL;
  try {
    parsed = new URL(apiBaseUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  const host = parsed.hostname.toLowerCase();
  if (host === "api.github.com") return GITHUB_ORIGIN;
  // Data residency: the API is `api.<tenant>.ghe.com`, the web UI `<tenant>.ghe.com`.
  const tenant = GHE_CLOUD_API_HOST_RE.exec(host);
  if (tenant) return `https://${tenant[1]}`;
  // `origin` drops any path (`/api/v3`) and any embedded credentials.
  return parsed.origin;
}

/**
 * The repository a project's code links point into: its single live GitHub or
 * GitHub Enterprise connector. A code link carries no connector id, so with
 * none or several the target is not known and this is `null` (paths stay text).
 */
export function selectCodeLinkRepo(connectors: readonly CodeLinkRepoSource[]): CodeLinkRepo | null {
  const github = connectors.filter(
    (c) => c.provider === "github" || c.provider === "github_enterprise",
  );
  if (github.length !== 1) return null;
  const c = github[0]!;
  const origin = githubWebOrigin(c.provider, c.apiBaseUrl);
  const owner = c.ownerOrOrg ?? "";
  const repo = c.repoName ?? "";
  if (!origin || !NAME_RE.test(owner) || !NAME_RE.test(repo)) return null;
  const sha = c.lastCommitSha?.trim();
  const ref = sha && SHA_RE.test(sha) ? sha : (c.defaultBranch ?? "");
  if (!ref || !REF_RE.test(ref) || ref.split("/").includes("..")) return null;
  return { origin, owner, repo, ref };
}

/** Repository-relative path segments, or `null` if the path is not safe to link. */
function safePathSegments(filePath: string): string[] | null {
  if (!filePath || CONTROL_RE.test(filePath) || filePath.includes("\\")) return null;
  if (filePath.startsWith("/") || SCHEME_RE.test(filePath)) return null;
  const segments = filePath.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) return null;
  return segments;
}

/** `encodeURIComponent`, plus the parentheses a Markdown link target ends on. */
function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/\(/g, "%28").replace(/\)/g, "%29");
}

function lineRange(link: Pick<DraftCodeLink, "startLine" | "endLine">): [number, number] | null {
  const { startLine, endLine } = link;
  if (startLine === null || !Number.isInteger(startLine) || startLine < 1) return null;
  const end = endLine !== null && Number.isInteger(endLine) && endLine > startLine ? endLine : null;
  return [startLine, end ?? startLine];
}

/**
 * `https://<host>/<owner>/<repo>/blob/<ref>/<path>#L<start>-L<end>`, or `null`
 * when there is no repository or the path is not a plain relative one.
 */
export function buildCodeLinkUrl(repo: CodeLinkRepo | null, link: DraftCodeLink): string | null {
  if (!repo) return null;
  const segments = safePathSegments(link.filePath);
  if (!segments) return null;
  const range = lineRange(link);
  const fragment = !range
    ? ""
    : range[0] === range[1]
      ? `#L${range[0]}`
      : `#L${range[0]}-L${range[1]}`;
  return (
    `${repo.origin}/${encodeSegment(repo.owner)}/${encodeSegment(repo.repo)}` +
    `/blob/${repo.ref.split("/").map(encodeSegment).join("/")}` +
    `/${segments.map(encodeSegment).join("/")}${fragment}`
  );
}

/** `text` cut to at most `max` UTF-16 units without splitting a surrogate pair. */
function cutAt(text: string, max: number): string {
  if (text.length <= max) return text;
  const last = text.charCodeAt(max - 1);
  // A high surrogate at the cut has lost its low half: drop it too.
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

/**
 * Untrusted text as a Markdown inline code span. Inside a span nothing is
 * interpreted, and the fence is one backtick longer than the longest run in
 * the text, so the text cannot close it. The text is kept on one line, and
 * cannot be (or open, or close) an HTML comment: see the note at the top.
 */
export function inlineCode(text: string): string {
  let clean = text
    .replace(CONTROL_RE_GLOBAL, " ")
    .replace(INVISIBLE_RE_GLOBAL, "")
    // The opener is what makes a comment, in HTML5 and in CommonMark alike; it
    // also covers the short forms `<!-->` and `<!--->`.
    .replace(/<!--/g, "<!- -")
    // Both closers: HTML5 ends a comment at `--!>` as well as at `-->`.
    .replace(/--(!?)>/g, "- -$1>")
    .trim();
  if (clean.length > MAX_CODE_TEXT) clean = `${cutAt(clean, MAX_CODE_TEXT - 1)}…`;
  if (clean === "") clean = "?";
  let longest = 0;
  for (const run of clean.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  if (longest === 0) return `\`${clean}\``;
  const fence = "`".repeat(longest + 1);
  return `${fence} ${clean} ${fence}`;
}

function linkKey(link: DraftCodeLink): string {
  return JSON.stringify([link.filePath, link.startLine, link.endLine, link.symbolName]);
}

/**
 * The linked form of a location: the code span as the text of a link to `url`.
 * {@link codeLinksAsText} is its inverse; keep the two together.
 */
function linkedLocation(code: string, url: string): string {
  return `[${code}](${url})`;
}

function renderLink(link: DraftCodeLink, repo: CodeLinkRepo | null): string {
  const range = lineRange(link);
  const where = !range
    ? link.filePath
    : range[0] === range[1]
      ? `${link.filePath}:${range[0]}`
      : `${link.filePath}:${range[0]}-${range[1]}`;
  // A square bracket in the row's text and the location is plain code, never a
  // link. Markdown finds link reference definitions (`[label]: destination`)
  // before it reads any inline content, and a label ends at the first `]`
  // whether or not a backtick came before it — so `[` + a path holding `]:` was
  // a definition, not a link: the row rendered as an empty bullet and gave the
  // rest of the body a link label pointing wherever the path said. A row that
  // starts with a backtick cannot be a definition.
  const bracketed = /[[\]]/.test(`${where}${link.symbolName ?? ""}`);
  const url = bracketed ? null : buildCodeLinkUrl(repo, link);
  const location = url ? linkedLocation(inlineCode(where), url) : inlineCode(where);
  if (!link.symbolName) return `- ${location}`;
  const kind = link.symbolKind && KIND_RE.test(link.symbolKind) ? ` (${link.symbolKind})` : "";
  return `- ${location} — ${inlineCode(link.symbolName)}${kind}`;
}

/** The section's heading line. */
const CODE_LINKS_HEADING = "## Related code";

/** The closing line of a section whose paths are text, not links. */
export const CODE_LINKS_AS_TEXT_NOTE =
  "_These paths are in the repository METIS analysed. They are written as text, not links, " +
  "because this issue is not known to be in that repository._";

/**
 * The section's Markdown lines. Links are listed in the order given (the
 * loader's: highest confidence first), exact repeats once, and at most
 * {@link MAX_DRAFT_CODE_LINKS}; what is left out is counted in a closing line.
 *
 * `repo` is the repository to link into, and must be `null` unless the issue is
 * published into that same repository: with `null` every path is plain code and
 * the section names no repository, owner or commit. `total` is how many links
 * the requirement holds when `links` is only the first of them.
 */
export function renderCodeLinksSection(
  links: readonly DraftCodeLink[],
  repo: CodeLinkRepo | null,
  total?: number,
): string[] {
  const seen = new Set<string>();
  const unique = links.filter((link) => {
    const key = linkKey(link);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (unique.length === 0) {
    return [CODE_LINKS_HEADING, ``, `_METIS recorded no code links for this requirement._`];
  }
  const shown = unique.slice(0, MAX_DRAFT_CODE_LINKS);
  // Repeats among the rows read are not locations of their own.
  const all = Math.max(unique.length, (total ?? 0) - (links.length - unique.length));
  const hidden = all - shown.length;
  return [
    CODE_LINKS_HEADING,
    ``,
    `_Code METIS linked to this requirement. A starting point, not a complete list of what to change._`,
    ``,
    ...shown.map((link) => renderLink(link, repo)),
    ...(hidden > 0
      ? [
          ``,
          `_…and ${hidden} more linked location${hidden === 1 ? "" : "s"} not shown — the requirement in METIS lists all ${all}._`,
        ]
      : []),
    ...(repo ? [] : [``, CODE_LINKS_AS_TEXT_NOTE]),
  ];
}

/** One requirement's links: the first rows read, and how many it holds in all. */
export interface RequirementCodeLinks {
  links: DraftCodeLink[];
  total: number;
}

export interface DraftCodeLinks {
  /**
   * The repository to link into — set only when the drafts are generated for
   * that same repository. `null` writes every path as plain code.
   */
  repo: CodeLinkRepo | null;
  byRequirement: Map<string, RequirementCodeLinks>;
}

/**
 * The most mapping rows read for one requirement. An issue lists
 * {@link MAX_DRAFT_CODE_LINKS}; the margin absorbs exact repeats. Beyond it the
 * rows are counted, not loaded, so a Generate over a broad import reads at most
 * this many rows per requirement however many links each one holds.
 */
export const CODE_LINK_READ_CAP = 50;

/** Requirements read at once. */
const READ_CONCURRENCY = 10;

/** `https://<host>/<owner>/<repo>` — the prefix every link into `repo` starts with. */
export function codeLinkBase(repo: CodeLinkRepo): string {
  return `${repo.origin}/${encodeSegment(repo.owner)}/${encodeSegment(repo.repo)}`;
}

/** Where issues are published: a repository on a host. */
export interface PublishTarget {
  owner: string;
  repo: string;
  /**
   * The target's API base URL as the batch form holds it. `null` is the
   * publisher's default, public GitHub. `undefined` means the caller does not
   * know the host — which is never read as "probably the same one".
   */
  baseUrl: string | null | undefined;
}

/**
 * A publish target in the form of {@link codeLinkBase}, lower-cased (GitHub
 * compares owner and repository names case-insensitively, and a host name has
 * no case), or `null` when its host is not known or not an https origin.
 *
 * THE one definition of "the target is this repository": generation decides
 * whether to write links with it, and {@link assertCodeLinksMatchTarget} checks
 * a batch with it — owner, name AND host both times. When generation compared
 * names only, a same-named repository on another host got links at Generate
 * and a refusal at publish that generating again could never clear.
 */
export function publishTargetBase(target: PublishTarget): string | null {
  if (target.baseUrl === undefined) return null;
  // The publisher treats a batch without a base URL as public GitHub.
  const origin = githubWebOrigin("github", target.baseUrl);
  if (origin === null) return null;
  return `${origin}/${encodeSegment(target.owner.trim())}/${encodeSegment(target.repo.trim())}`.toLowerCase();
}

/** Is `target` the repository `repo` — same host, owner and name? */
function isPublishTarget(repo: CodeLinkRepo, target: PublishTarget): boolean {
  return codeLinkBase(repo).toLowerCase() === publishTargetBase(target);
}

async function readRequirementLinks(
  projectId: string,
  requirementId: string,
): Promise<RequirementCodeLinks> {
  const where = { projectId, requirementId };
  const rows = await prisma.requirementCodeMapping.findMany({
    where,
    select: {
      filePath: true,
      startLine: true,
      endLine: true,
      codeSymbol: { select: { name: true, kind: true } },
    },
    orderBy: [{ confidence: "desc" }, { filePath: "asc" }, { startLine: "asc" }, { id: "asc" }],
    take: CODE_LINK_READ_CAP,
  });
  const total =
    rows.length < CODE_LINK_READ_CAP
      ? rows.length
      : await prisma.requirementCodeMapping.count({ where });
  return {
    total,
    links: rows.map((row) => ({
      filePath: row.filePath,
      startLine: row.startLine,
      endLine: row.endLine,
      symbolName: row.codeSymbol?.name ?? null,
      symbolKind: row.codeSymbol?.kind ?? null,
    })),
  };
}

/**
 * The persisted code links of a draft run's requirements. Ordered so the same
 * rows always render the same body (the body is hashed to decide whether a
 * published issue changed), and bounded per requirement
 * ({@link CODE_LINK_READ_CAP}). `target` is the repository the drafts are
 * generated for: links are offered only when it is the connector's own
 * repository on the connector's own host ({@link publishTargetBase}) — and so
 * never when the target's host is not known. Returns `null` when the links
 * could not be read: the draft is then generated without the section rather
 * than failing, or claiming a requirement has no links.
 */
export async function loadDraftCodeLinks(
  projectId: string,
  requirementIds: readonly string[],
  target: PublishTarget,
): Promise<DraftCodeLinks | null> {
  try {
    const connectors = await prisma.repoConnection.findMany({
      where: {
        projectId,
        deletedAt: null,
        provider: { in: ["github", "github_enterprise"] },
      },
      select: {
        provider: true,
        ownerOrOrg: true,
        repoName: true,
        defaultBranch: true,
        apiBaseUrl: true,
        lastCommitSha: true,
      },
    });
    const byRequirement = new Map<string, RequirementCodeLinks>();
    for (let i = 0; i < requirementIds.length; i += READ_CONCURRENCY) {
      const chunk = requirementIds.slice(i, i + READ_CONCURRENCY);
      const read = await Promise.all(chunk.map((id) => readRequirementLinks(projectId, id)));
      chunk.forEach((id, n) => byRequirement.set(id, read[n]!));
    }
    const repo = selectCodeLinkRepo(connectors);
    return {
      repo: repo && isPublishTarget(repo, target) ? repo : null,
      byRequirement,
    };
  } catch (err) {
    log.warn("could not read code links; drafts are generated without them", {
      projectId,
      error: (err as Error).message,
    });
    return null;
  }
}

/** The repository a draft's generator recorded its code links point into, if any. */
function recordedCodeLinkBase(metadata: string | null | undefined): string | null {
  try {
    const base = (JSON.parse(metadata ?? "{}") as { codeLinkBase?: unknown } | null)?.codeLinkBase;
    return typeof base === "string" && base !== "" ? base : null;
  } catch {
    return null;
  }
}

/** The most drafts a refusal names; the rest are counted. */
const MAX_NAMED_DRAFTS = 5;

/** A draft as an error message names it: its title, cut, else its id. */
function draftName(draft: { id: string; title?: string | null }): string {
  const title = (draft.title ?? "").replace(/\s+/g, " ").trim();
  if (title === "") return draft.id;
  return `"${title.length > 80 ? `${cutAt(title, 79)}…` : title}"`;
}

/**
 * A draft whose body links into one repository must not be published into
 * another: the links name the analysed repository, its owner and a commit.
 * Generation already writes plain paths for any other target; this holds a
 * batch to the same rule when it is pointed somewhere other than the target
 * the drafts were generated for (the batch form lets the user change it).
 *
 * A draft is refused only when its generator recorded the repository it linked
 * into (`metadata.codeLinkBase`), its body still contains a link there, and
 * the batch target is a different repository or host
 * ({@link publishTargetBase}, the comparison generation makes). There are two
 * ways out and the message names both: generating the drafts again for this
 * target — owner, repository and base URL — writes the code as text, except in
 * a draft whose text is being kept (edited by hand, or held because it is
 * signed off); removing the links in the draft editor clears any draft.
 * Nothing here calls the network.
 */
export function assertCodeLinksMatchTarget(
  drafts: ReadonlyArray<{
    id: string;
    body: string;
    metadata: string | null;
    title?: string | null;
  }>,
  target: { owner: string; repo: string; baseUrl: string | null | undefined },
): void {
  const targetBase = publishTargetBase({
    ...target,
    baseUrl: target.baseUrl ?? null,
  });
  const offending = drafts.filter((draft) => {
    const base = recordedCodeLinkBase(draft.metadata);
    if (base === null || base.toLowerCase() === targetBase) return false;
    return draft.body.includes(`${base}/blob/`);
  });
  if (offending.length === 0) return;
  const named = offending.slice(0, MAX_NAMED_DRAFTS).map(draftName).join(", ");
  const more = offending.length - MAX_NAMED_DRAFTS;
  const one = offending.length === 1;
  throw new PublishError(
    409,
    "CODE_LINKS_TARGET_MISMATCH",
    `${offending.length} draft${one ? "" : "s"} link${one ? "s" : ""} into the analysed ` +
      `repository, which is not ${target.owner}/${target.repo} on this host: ${named}` +
      `${more > 0 ? ` and ${more} more` : ""}. Two ways to publish here: generate the drafts ` +
      `again for this target (same owner, repository and base URL) — the code is then listed ` +
      `as text, except in a draft whose text was edited by hand or is kept because it is ` +
      `signed off; or remove the links from ${one ? "that draft" : "those drafts"} in the editor.`,
    false,
    { draftIds: offending.map((d) => d.id) },
  );
}

/** What stands where a link into the analysed repository was taken out. */
const LINK_REMOVED = "(link removed)";

/** The character after a blob URL that METIS wrote as a link target. */
const LINK_URL_END = /[\s()]/;
/** The character after a blob URL found anywhere else in a body. */
const BARE_URL_END = /[\s()<>[\]]/;

/**
 * `s` with its ASCII capitals lower-cased and every other character left alone,
 * so the result has the length of the input and an index into one is an index
 * into the other. (`toLowerCase` can change the length of non-ASCII text.)
 */
function asciiLower(s: string): string {
  return s.replace(/[A-Z]+/g, (run) => run.toLowerCase());
}

function endOfUrl(body: string, from: number, stop: RegExp): number {
  let i = from;
  while (i < body.length && !stop.test(body[i]!)) i += 1;
  return i;
}

/**
 * The `[` that opens the link text closing at `close`, looking back no further
 * than `floor`; -1 when the text between holds a bracket or a line break (a
 * linked code span never does: see `renderLink`).
 */
function linkTextStart(body: string, close: number, floor: number): number {
  for (let i = close - 1; i >= floor; i -= 1) {
    const c = body[i];
    if (c === "[") return i;
    if (c === "]" || c === "\n") return -1;
  }
  return -1;
}

/**
 * `body` without any URL under `blobPrefix` (compared without regard to ASCII
 * case, as a host and GitHub names are). A link METIS wrote — the inverse of
 * `linkedLocation`, `[<text>](<blob URL>)` — is replaced by its text; any other
 * occurrence of such a URL by {@link LINK_REMOVED}. One pass by string search:
 * `blobPrefix` comes from stored draft metadata, and no pattern is built from it.
 */
function withoutBlobUrls(body: string, blobPrefix: string): string {
  const needle = asciiLower(blobPrefix);
  const haystack = asciiLower(body);
  let out = "";
  let pos = 0;
  for (;;) {
    const at = haystack.indexOf(needle, pos);
    if (at < 0) break;
    // A blob URL METIS builds never holds a space or a parenthesis (`encodeSegment`).
    const linkEnd = endOfUrl(body, at + needle.length, LINK_URL_END);
    const open =
      at - 2 >= pos && body.startsWith("](", at - 2) && body[linkEnd] === ")"
        ? linkTextStart(body, at - 2, pos)
        : -1;
    if (open >= 0) {
      out += body.slice(pos, open) + body.slice(open + 1, at - 2);
      pos = linkEnd + 1;
    } else {
      out += body.slice(pos, at) + LINK_REMOVED;
      pos = endOfUrl(body, at + needle.length, BARE_URL_END);
    }
  }
  return out + body.slice(pos);
}

/**
 * `body` with its Related code section in the PLAIN form: every link into
 * `base` (a {@link codeLinkBase}) replaced by the code text it wrapped, and the
 * note that the paths are text added under the rows. For a body the generator
 * wrote this is, character for character, the body it would have written for a
 * target that is not the analysed repository — the test holds the two equal, so
 * "plain form" has one definition. Any other URL into `base` (one a reviewer
 * typed or pasted) is taken out as well: what leaves here names no commit and
 * no blob URL of the analysed repository.
 */
export function codeLinksAsText(body: string, base: string): string {
  const text = withoutBlobUrls(body, `${base}/blob/`);
  if (text.includes(CODE_LINKS_AS_TEXT_NOTE)) return text;
  const lines = text.split("\n");
  // The generator writes the section after the requirement's own text.
  const heading = lines.lastIndexOf(CODE_LINKS_HEADING);
  if (heading < 0) return text;
  let lastLine = heading;
  let hasRows = false;
  for (let i = heading + 1; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line === "---" || /^#{1,6} /.test(line)) break;
    if (line.trim() !== "") lastLine = i;
    if (line.startsWith("- ")) hasRows = true;
  }
  if (!hasRows) return text;
  lines.splice(lastLine + 1, 0, "", CODE_LINKS_AS_TEXT_NOTE);
  return lines.join("\n");
}

/**
 * A draft's body for a tracker that is NOT the repository the code was
 * analysed from — Jira, always: the Related code section in its plain form
 * ({@link codeLinksAsText}). A draft whose generator recorded no repository
 * has no links to take out and is returned as it is.
 */
export function bodyWithCodeAsText(draft: { body: string; metadata?: string | null }): string {
  const base = recordedCodeLinkBase(draft.metadata);
  return base === null ? draft.body : codeLinksAsText(draft.body, base);
}
