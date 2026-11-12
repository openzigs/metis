/**
 * #2335 — read a verified GitHub `push` body into the few facts the re-ingest
 * receiver acts on, each matched against a strict pattern first.
 *
 * Nothing read here ever reaches a shell or a git argument: the refresh pulls
 * the connector's own configured branch, so the ref is only compared with that
 * stored value, the repository name only selects connectors by equality, and
 * the commit SHA is only recorded. The patterns are defence in depth, and they
 * keep a malformed field out of the logs.
 */

/** A full git object id: SHA-1 (40 hex) or SHA-256 (64 hex), lower case as GitHub sends it. */
export const COMMIT_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

const ZERO_SHA = /^0+$/;
const REPO_FULL_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
/** `refs/<kind>/<name>` with git's safe ref characters only. */
const REF_PATTERN = /^refs\/(heads|tags)\/([A-Za-z0-9._/-]{1,240})$/;

export type PushIgnoredReason =
  "INVALID_REPOSITORY" | "INVALID_REF" | "REF_DELETED" | "TAG_PUSH" | "INVALID_COMMIT_SHA";

export type ParsedPush =
  | {
      kind: "branch";
      /** The branch name, without `refs/heads/`. */
      branch: string;
      /** The commit the branch now points at. */
      commitSha: string;
      repoFullName: string;
      /** For the host check (github.com or an Enterprise server); not otherwise used. */
      repoHtmlUrl: string | null;
    }
  | { kind: "ignored"; reason: PushIgnoredReason };

/** A ref name git itself would accept, within {@link REF_PATTERN}'s characters. */
function isSafeRefName(name: string): boolean {
  return (
    !name.includes("..") &&
    !name.includes("//") &&
    !name.startsWith("/") &&
    !name.endsWith("/") &&
    !name.endsWith(".") &&
    !name.endsWith(".lock") &&
    !name.split("/").some((part) => part.startsWith(".") || part.startsWith("-"))
  );
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * The branch push a verified body describes, or why it is ignored: a tag push,
 * a deleted ref, or any field that fails its pattern.
 */
export function parsePushEvent(payload: unknown): ParsedPush {
  const body = isObject(payload) ? payload : {};
  const repo = isObject(body.repository) ? body.repository : {};
  const fullName = repo.full_name;
  if (typeof fullName !== "string" || !REPO_FULL_NAME_PATTERN.test(fullName)) {
    return { kind: "ignored", reason: "INVALID_REPOSITORY" };
  }
  const ref = typeof body.ref === "string" ? body.ref : "";
  const match = REF_PATTERN.exec(ref);
  if (!match || !isSafeRefName(match[2]!)) return { kind: "ignored", reason: "INVALID_REF" };
  const after = typeof body.after === "string" ? body.after : "";
  if (body.deleted === true || ZERO_SHA.test(after)) {
    return { kind: "ignored", reason: "REF_DELETED" };
  }
  if (match[1] === "tags") return { kind: "ignored", reason: "TAG_PUSH" };
  if (!COMMIT_SHA_PATTERN.test(after)) return { kind: "ignored", reason: "INVALID_COMMIT_SHA" };
  return {
    kind: "branch",
    branch: match[2]!,
    commitSha: after,
    repoFullName: fullName,
    repoHtmlUrl: typeof repo.html_url === "string" ? repo.html_url : null,
  };
}
