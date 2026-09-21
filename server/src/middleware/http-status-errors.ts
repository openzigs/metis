/**
 * Central classification of the server's status-carrying error classes (#1065).
 *
 * ## The problem
 *
 * `errorHandler` branched on exactly two types — `ZodError` and `AppError`.
 * Every other error class fell through to a generic 500, discarding the status
 * its author intended: `JiraApiError(400, "INVALID_URL")` surfaced as a 500
 * (#1054) and `ConnectorError(404, "JIRA_CONNECTION_NOT_FOUND")` surfaced as a
 * 500 (#1055). Both were papered over with a per-route translation, which the
 * next custom error class would have had to reinvent.
 *
 * ## The two rules
 *
 * **1. Only an "own-status" class maps its status through.** A sweep of
 * `server/src` found two distinct populations of status-carrying error. For
 * some, `status` is the status *our* API means to return (`ProjectError(404)`).
 * For others it is a status copied off an *upstream* response — the embeddings
 * backend, the SQL-lineage sidecar, PagerDuty, Jira's own API. Mapping an
 * upstream 401 through would tell the caller *they* are unauthenticated when in
 * fact one of our dependencies is. Those classes are listed here as `upstream`
 * and deliberately keep falling through to a 500.
 *
 * **2. `err.message` is NEVER forwarded.** `AppError` is the one type whose
 * message is client-safe by construction — it is written at the throw site for
 * exactly that purpose. Any *other* error reaching the central handler did so
 * without passing a route-level translation that vetted its message, so the
 * handler cannot assume the message is safe. And several demonstrably are not:
 * `ConnectorError` embeds the resolved private address the SSRF allow-list
 * rejected (`"…resolves to private/loopback address 169.254.169.254"`), the DB
 * connector wraps raw driver errors that carry connection strings, and
 * `JiraApiError` may carry the upstream Jira response body's `message` field
 * verbatim. So the central path maps the **status** and the **code**, and
 * derives the message from the status. This makes the sanitisation property PR
 * #1062 established structural rather than a per-route habit.
 *
 * The `code` is echoed only when it is a bare SCREAMING_SNAKE identifier, so a
 * code cannot smuggle back the free text the message policy strips.
 *
 * The table is kept honest by a drift guard in the sibling test file: it
 * re-runs the sweep over `server/src` and fails if any status-carrying error
 * class is unclassified.
 */

/** How the central error handler must treat a class's HTTP status. */
export type StatusProvenance =
  /** The status is the one our API intends to return — map it through. */
  | "own"
  /** The status came off an upstream response — must NOT reach the client. */
  | "upstream";

/**
 * Every error class in `server/src` that carries an HTTP status, classified.
 *
 * `AppError` is deliberately absent: it is handled by its own `instanceof`
 * branch in `errorHandler`, which (uniquely) also forwards its message.
 */
export const HTTP_STATUS_ERROR_CLASSES: Readonly<Record<string, StatusProvenance>> = {
  // ── own status: the API's intended response ──────────────────────────────
  AIError: "own",
  AgentServiceError: "own",
  AllowlistError: "own",
  AnalysisNotRegeneratableError: "own",
  ApiTokenError: "own",
  AutopilotCostCeilingError: "own",
  AutopilotDisabledError: "own",
  BudgetExceededError: "own",
  ChangeAnalysisError: "own",
  ConnectorError: "own",
  CostCapExceededError: "own",
  GateUnmetError: "own",
  ImpactAnalysisError: "own",
  JiraApiError: "own",
  JiraPublishError: "own",
  LibraryImportError: "own",
  MCPRegistryError: "own",
  PagerDutyServiceConfigError: "own",
  ProductError: "own",
  ProjectError: "own",
  // NOTE: two unrelated classes are named `PublishError` —
  // `lib/publishing/types.ts` (carries a status) and
  // `lib/scanner/finding-publisher.ts` (code only, no status). Since the
  // structural check below also requires a numeric status, the scanner one
  // still falls through to the 500 branch exactly as it does today.
  PublishError: "own",
  SafetyDeniedError: "own",
  SchedulerError: "own",
  SessionRuntimeError: "own",
  SkillServiceError: "own",
  SlackInstallationError: "own",
  SlackOAuthError: "own",
  SpecKitArtifactError: "own",
  SpecKitFeatureLifecycleError: "own",
  StakeholderError: "own",
  TeamsInstallationError: "own",
  TeamsLinkError: "own",
  TeamsNotificationTargetError: "own",
  TemplateServiceError: "own",
  UrlFetchError: "own",

  // ── upstream status: a dependency's response code, not ours ──────────────
  // Surfacing these would mis-attribute a dependency failure to the caller, so
  // they keep falling through to the 500 branch.
  DiffApplyClientError: "upstream", // diff-apply sidecar
  EmbedBackendHttpError: "upstream", // embeddings HTTP backend
  EmbeddingsClientError: "upstream", // embeddings service
  ImporterHttpError: "upstream", // arbitrary imported URL
  PagerDutyApiError: "upstream", // PagerDuty Events API
  RemoteCopilotClientError: "upstream", // remote Copilot service
  RetryableHttpError: "upstream", // Bedrock invoke retry loop
  SandboxClientError: "upstream", // sandbox service
  SmitheryError: "upstream", // Smithery MCP registry
  SpecKitMcpHttpError: "upstream", // remote Spec Kit MCP server
  SqlLineageClientError: "upstream", // SQL-lineage sidecar
  StructuredOutputRejectedError: "upstream", // Bedrock structured-output probe
  TemperatureUnsupportedError: "upstream", // Bedrock `temperature` deprecation probe
};

/** A code is echoed only if it is a bare machine identifier. */
const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

/** The client-facing shape the central handler renders. */
export interface MappedHttpError {
  statusCode: number;
  code: string;
  /** Derived from the status — never taken from `err.message`. */
  message: string;
}

/**
 * A detail-free, human-readable message for `status`.
 *
 * Deliberately says nothing the caller did not already know from the status
 * itself: no hostnames, no addresses, no paths, no upstream text.
 */
export function genericMessageForStatus(status: number): string {
  switch (status) {
    case 400:
      return "The request could not be processed.";
    case 401:
      return "Authentication is required.";
    case 403:
      return "You do not have access to this resource.";
    case 404:
      return "The requested resource was not found.";
    case 409:
      return "The request conflicts with the current state of the resource.";
    case 413:
      return "The request payload is too large.";
    case 415:
      return "The request media type is not supported.";
    case 429:
      return "Too many requests — please retry in a moment.";
    case 502:
    case 503:
    case 504:
      return "The service is temporarily unavailable.";
    default:
      return status < 500 ? "The request could not be processed." : "An unexpected error occurred.";
  }
}

/** Fallback code when the class's own code is missing or not identifier-shaped. */
function fallbackCodeForStatus(status: number): string {
  switch (status) {
    case 400:
      return "BAD_REQUEST";
    case 401:
      return "AUTH_REQUIRED";
    case 403:
      return "FORBIDDEN";
    case 404:
      return "NOT_FOUND";
    case 409:
      return "CONFLICT";
    case 429:
      return "RATE_LIMITED";
    default:
      return status < 500 ? "BAD_REQUEST" : "UPSTREAM_ERROR";
  }
}

/** Read a numeric HTTP status off `status` or `statusCode`, whichever is set. */
function statusOf(err: Error): unknown {
  const withStatus = err as { status?: unknown; statusCode?: unknown };
  return withStatus.status ?? withStatus.statusCode;
}

/**
 * Map an "own-status" error onto a sanitised client envelope, or `null` if the
 * error is not one the central handler is allowed to map (in which case the
 * caller must fall through to its 500 branch).
 */
export function mapStatusCarryingError(err: unknown): MappedHttpError | null {
  // A real Error instance only — a plain object that merely mimics the shape
  // (e.g. a parsed JSON body forwarded as an "error") must not steer the status.
  if (!(err instanceof Error)) return null;

  // `hasOwnProperty` rather than a bare lookup: an error named `toString` or
  // `constructor` must not resolve through the object prototype.
  if (!Object.prototype.hasOwnProperty.call(HTTP_STATUS_ERROR_CLASSES, err.name)) return null;
  if (HTTP_STATUS_ERROR_CLASSES[err.name] !== "own") return null;

  const status = statusOf(err);
  if (typeof status !== "number" || !Number.isInteger(status)) return null;
  if (status < 400 || status > 599) return null;

  const rawCode = (err as { code?: unknown }).code;
  const code =
    typeof rawCode === "string" && SAFE_CODE.test(rawCode)
      ? rawCode
      : fallbackCodeForStatus(status);

  return { statusCode: status, code, message: genericMessageForStatus(status) };
}

/** Matches the declaration line of a class extending `Error` / `AppError`. */
const CLASS_HEADER =
  /^(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z0-9_$]+)\s+extends\s+(?:Error|AppError)\s*\{/;
/**
 * Matches a numeric HTTP-status member, in either of the two shapes the
 * codebase uses: a typed field or constructor parameter (`status: number`) and
 * a literal initialiser (`readonly status = 409`). Missing the second shape
 * hides seven classes, so the guard would pass vacuously.
 */
const STATUS_MEMBER = /\b(?:status|statusCode|httpStatus)\??\s*(?::\s*number\b|=\s*[1-5]\d\d\b)/;

/**
 * Re-run the #1065 sweep over one TypeScript source file's text: return the
 * names of the classes it declares that extend `Error`/`AppError` AND carry a
 * numeric HTTP status.
 *
 * Line-oriented on purpose — the repo is Prettier-formatted, so a top-level
 * class body reliably ends at a column-zero `}`. Used by the drift guard, not
 * at runtime.
 */
export function scanForStatusCarryingErrorClasses(source: string): string[] {
  const lines = source.split("\n");
  const names: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const header = CLASS_HEADER.exec(lines[i]);
    if (!header) continue;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j] === "}" || CLASS_HEADER.test(lines[j])) break;
      if (STATUS_MEMBER.test(lines[j])) {
        names.push(header[1]);
        break;
      }
    }
  }
  return names;
}
