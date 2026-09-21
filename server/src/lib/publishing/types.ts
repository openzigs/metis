/**
 * Internal publishing types — Phase 9 (#65).
 *
 * Public, validated types live in `@metis/shared/publishing`. This module
 * carries the implementation-only structures (Octokit shims, retry config,
 * error envelope, emitter shape).
 */
import type {
  PublishCompletedEvent,
  PublishProgressEvent,
  PublishStatusEvent,
} from "@metis/shared";
import type { RestEndpointMethodTypes } from "@octokit/rest";

export class PublishError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  constructor(status: number, code: string, message: string, retryable = false) {
    super(message);
    this.name = "PublishError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

export interface PublishEmitter {
  status(event: Omit<PublishStatusEvent, "ts">): void;
  progress(event: Omit<PublishProgressEvent, "ts">): void;
  completed(event: Omit<PublishCompletedEvent, "ts">): void;
}

export const NOOP_PUBLISH_EMITTER: PublishEmitter = {
  status: () => undefined,
  progress: () => undefined,
  completed: () => undefined,
};

export interface PublishRateLimitConfig {
  delayMs: number;
  jitterMs: number;
  secondaryBackoffBaseMs: number;
  secondaryBackoffMaxMs: number;
  maxRetries: number;
  backoffBudgetMs: number;
}

export interface OctokitRequestArgs {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  url: string;
  headers?: Record<string, string>;
  data?: unknown;
}

export interface OctokitResponseLike<T = unknown> {
  status: number;
  headers: Record<string, string | undefined>;
  data: T;
}

/**
 * Minimal Octokit surface the publisher consumes. The repo connector uses
 * the higher-level `rest.*` namespace; the publisher uses the raw `request`
 * channel to attach version headers + custom hooks deterministically.
 */
export interface PublishOctokitLike {
  request<T = unknown>(args: OctokitRequestArgs): Promise<OctokitResponseLike<T>>;
}

export interface OctokitFactoryArgs {
  baseUrl: string;
  token: string;
  pinnedAddress?: string;
  pinnedFamily?: 4 | 6;
  rateLimit: PublishRateLimitConfig;
}

export type OctokitFactory = (args: OctokitFactoryArgs) => Promise<PublishOctokitLike>;

/**
 * The subset of GitHub's REST `issue` resource the publisher reads.
 *
 * #1091 — this interface used to declare `id: string` with the comment
 * "node id". That was a lie the compiler could not catch (every response is
 * cast to `GhIssue`), and it broke the pipeline in the worst possible way:
 * `PublishedIssue.issueId` is a `String` column, so every `upsert` after a
 * *successful* GitHub write threw `Expected String, provided Int` — issues
 * live on GitHub, zero recorded locally.
 *
 * The REST issue resource carries **two** identifiers plus the number, and
 * they are not interchangeable:
 *
 *   - `id`      — numeric database id (e.g. `4993133084`). Required by the
 *                 sub-issue API's `sub_issue_id` body field.
 *   - `node_id` — GraphQL global node id (e.g. `I_kwDO…`). Required by
 *                 `addProjectV2ItemById(contentId:)` and by the issue-webhook
 *                 reconcile path, which matches on `PublishedIssue.issueId`.
 *   - `number`  — the human-facing per-repo number used in REST URLs.
 *
 * `PublishedIssue.issueId` stores the **`node_id`** — see the module docblock
 * in `publisher.ts` for why.
 */
export interface GhIssue {
  /** Numeric database id. NOT the node id, NOT the issue number. */
  id: number;
  /** GraphQL global node id — what `PublishedIssue.issueId` persists. */
  node_id: string;
  number: number;
  html_url: string;
  title: string;
  body?: string | null;
  labels?: Array<{ name: string }> | string[];
  state?: string;
}

/**
 * Compile-time proof that `GhIssue` agrees with Octokit's own generated
 * OpenAPI types (#1091).
 *
 * A hand-written mock cannot catch a type lie — it declares whatever the test
 * author writes, which is exactly how `id: string` survived. These aliases are
 * derived from `@octokit/rest`'s published schema instead, so re-introducing
 * `id: string` (or dropping `node_id`) fails `pnpm typecheck` rather than
 * failing in production after the GitHub write.
 *
 * Kept in `src/` deliberately: `server/tsconfig.json` excludes `tests/`, so an
 * assertion parked in a test file would never run under the quality gate.
 */
type OctokitIssueResponse = RestEndpointMethodTypes["issues"]["create"]["response"]["data"];

/** `true` only when `A` is assignable to `B` and vice versa. */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

// Each line is `true` by construction; a mismatch makes it `false`, which is
// not assignable to `true`, and tsc reports it here.
type _GhIssueIdIsNumeric = Exact<GhIssue["id"], OctokitIssueResponse["id"]>;
type _GhIssueNodeIdIsString = Exact<GhIssue["node_id"], OctokitIssueResponse["node_id"]>;
type _GhIssueNumberIsNumeric = Exact<GhIssue["number"], OctokitIssueResponse["number"]>;
type _GhIssueHtmlUrlIsString = Exact<GhIssue["html_url"], OctokitIssueResponse["html_url"]>;
const _ghIssueConformsToOctokit: [
  _GhIssueIdIsNumeric,
  _GhIssueNodeIdIsString,
  _GhIssueNumberIsNumeric,
  _GhIssueHtmlUrlIsString,
] = [true, true, true, true];
void _ghIssueConformsToOctokit;

/**
 * The sub-issue API's request body, taken from Octokit's generated schema.
 *
 * #1091 — the publisher sent `sub_issue_id: <issue number>`. GitHub documents
 * this field as "The id of the sub-issue to add", i.e. the numeric **database
 * id**; the issue *number* is a separate path parameter (`issue_number`).
 * Sending the number addressed a database id that does not exist, GitHub
 * returned 404, and the retry loop read that 404 as "this host does not
 * support sub-issues" — caching the verdict for the whole repo and skipping
 * every remaining attach without recording a failure.
 *
 * Binding the body to the generated type means the compiler now rejects a
 * future attempt to pass the wrong identifier's type.
 */
export interface AddSubIssueBody {
  sub_issue_id: number;
  replace_parent?: boolean;
}

type OctokitAddSubIssueParams = RestEndpointMethodTypes["issues"]["addSubIssue"]["parameters"];
type _SubIssueIdIsNumeric = Exact<
  AddSubIssueBody["sub_issue_id"],
  OctokitAddSubIssueParams["sub_issue_id"]
>;
const _addSubIssueBodyConformsToOctokit: _SubIssueIdIsNumeric = true;
void _addSubIssueBodyConformsToOctokit;

/**
 * The two identifiers a freshly created/updated issue yields, separated so a
 * caller cannot pass the wrong one (#1091).
 */
export interface GhIssueIdentity {
  /** GraphQL node id — persisted to `PublishedIssue.issueId`. */
  nodeId: string;
  /** Numeric database id — the sub-issue API's `sub_issue_id`. */
  restId: number;
  /** Per-repo issue number — used to build REST URLs. */
  number: number;
  htmlUrl: string;
}

/**
 * Read the identity triple off a REST issue response, failing loudly if the
 * payload does not carry what we require.
 *
 * The cast at the call site (`client.request<GhIssue>`) is unchecked, so this
 * is the only place the runtime shape is actually verified. Without it a
 * future API change (or a proxy that strips fields) would once again surface
 * as a Prisma type error long after the issue exists on GitHub.
 */
export function readIssueIdentity(data: unknown): GhIssueIdentity {
  const d = data as Partial<GhIssue> | null | undefined;
  const nodeId = d?.node_id;
  const restId = d?.id;
  const number = d?.number;
  const htmlUrl = d?.html_url;
  if (typeof nodeId !== "string" || nodeId.length === 0) {
    throw new PublishError(
      502,
      "GH_ISSUE_SHAPE_INVALID",
      "GitHub issue response is missing a string `node_id`",
    );
  }
  if (typeof restId !== "number" || !Number.isFinite(restId)) {
    throw new PublishError(
      502,
      "GH_ISSUE_SHAPE_INVALID",
      "GitHub issue response is missing a numeric `id`",
    );
  }
  if (typeof number !== "number" || !Number.isFinite(number)) {
    throw new PublishError(
      502,
      "GH_ISSUE_SHAPE_INVALID",
      "GitHub issue response is missing a numeric `number`",
    );
  }
  return {
    nodeId,
    restId,
    number,
    htmlUrl: typeof htmlUrl === "string" ? htmlUrl : "",
  };
}

export interface GhLabel {
  name: string;
  color: string;
  description?: string;
}

export interface ResolvedRepoTarget {
  owner: string;
  repo: string;
  baseUrl: string;
  hostname: string;
  pinnedAddress?: string;
  pinnedFamily?: 4 | 6;
}
