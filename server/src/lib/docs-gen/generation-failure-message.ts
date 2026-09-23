/**
 * #52 — the user-facing reason a documentation generation failed.
 *
 * A failed generation used to persist `String(err)` on the row, and
 * `GET /projects/:projectId/docs/:docId` returned it verbatim: provider response
 * bodies, file paths, SQL error text. The socket path already sent only a
 * generic message (#254); the REST detail payload bypassed that rule.
 *
 * Every message a client can now see is one of the fixed strings below. A
 * failure is classified by its HTTP status (when the error carries one) and by
 * a few well-known phrases in its message — never echoed. The raw error stays
 * in the server log, where `generateDocumentAsync` already writes it.
 */
import { GENERATION_INTERRUPTED_MESSAGE } from "./interrupted-generations.js";
import { sectionFailedWarning } from "./grounding/degraded-warnings.js";

export const GENERATION_FAILED_MESSAGE =
  "Document generation failed. The details are in the server log; regenerate the document to try again.";

export const GENERATION_PROVIDER_BALANCE_MESSAGE =
  "The AI provider refused the request: 402 Insufficient Balance. Top up the provider account, then regenerate the document.";

export const GENERATION_BUDGET_EXCEEDED_MESSAGE =
  "This project's monthly token budget is used up. Raise the budget or wait for next month, then regenerate the document.";

export const GENERATION_PROVIDER_RATE_LIMITED_MESSAGE =
  "The AI provider rate-limited the request (429 Too Many Requests). Wait a few minutes, then regenerate the document.";

export const GENERATION_PROVIDER_AUTH_MESSAGE =
  "The AI provider rejected the configured credentials (401/403). Check the AI provider settings, then regenerate the document.";

/**
 * #98 — the most common real failure in local use: the provider host (a local
 * Ollama server, say) is down or unreachable, and undici throws only
 * `TypeError: fetch failed` with the OS error under `.cause`.
 */
export const GENERATION_PROVIDER_UNREACHABLE_MESSAGE =
  "The AI provider could not be reached (connection failed). Check that the provider host — for example a local Ollama server — is running and reachable from the METIS server, then regenerate the document.";

/**
 * #114 — the host answered the connect but sent no response (headers) or no
 * further body within undici's transport budget. On a local runtime that is
 * almost always a model still processing a large prompt: on 2026-09-23 a ~9.7
 * min prefill was reported as "unreachable" and sent two investigators looking
 * for a hung server that was working.
 */
export const GENERATION_PROVIDER_SLOW_MESSAGE =
  "The AI provider accepted the connection but did not respond in time. A local model may still be processing a large prompt rather than being down — check the provider's own log for progress, allow it more time or reduce the prompt, then regenerate the document.";

/** #114 — the provider's TLS certificate failed verification. */
export const GENERATION_PROVIDER_TLS_MESSAGE =
  "The AI provider's TLS certificate could not be verified. Check the provider URL and the certificate trust settings of the METIS server, then regenerate the document.";

/**
 * #114 — the connection was reset or closed while the response was arriving
 * (`ECONNRESET`, undici's `TypeError: terminated`). Observed live on 2026-09-23:
 * the Ollama host logged the request cancelled 52 s before METIS saw the dead
 * socket — a network drop between the hosts, not a stopped model.
 */
export const GENERATION_PROVIDER_DROPPED_MESSAGE =
  "The connection to the AI provider dropped while the response was arriving (reset or closed mid-response). This usually means a network interruption between METIS and the provider host rather than a stopped model; regenerate the document.";

/**
 * #152 — the host accepted the request and closed the connection before sending
 * any response. Node 22's undici reports it as `TypeError: fetch failed` with an
 * `UND_ERR_SOCKET` ("other side closed") cause; the same close after the
 * headers is `TypeError: terminated` — {@link GENERATION_PROVIDER_DROPPED_MESSAGE}.
 */
export const GENERATION_PROVIDER_CLOSED_MESSAGE =
  "The AI provider closed the connection before sending any response. The host accepted the request and then hung up — often a model runner that crashed or restarted, a proxy or load balancer timeout, or a runtime that refused the request; check the provider's own log, then regenerate the document.";

/** Every string a client may receive as a failed generation's `errorMessage`. */
const SAFE_MESSAGES: ReadonlySet<string> = new Set([
  GENERATION_INTERRUPTED_MESSAGE,
  GENERATION_FAILED_MESSAGE,
  GENERATION_PROVIDER_BALANCE_MESSAGE,
  GENERATION_BUDGET_EXCEEDED_MESSAGE,
  GENERATION_PROVIDER_RATE_LIMITED_MESSAGE,
  GENERATION_PROVIDER_AUTH_MESSAGE,
  GENERATION_PROVIDER_UNREACHABLE_MESSAGE,
  GENERATION_PROVIDER_SLOW_MESSAGE,
  GENERATION_PROVIDER_TLS_MESSAGE,
  GENERATION_PROVIDER_DROPPED_MESSAGE,
  GENERATION_PROVIDER_CLOSED_MESSAGE,
]);

// An HTTP status named as one: "returned 402", "status 429", "HTTP 401",
// "(403)", or a message that starts with it ("402 Insufficient Balance", the
// OpenAI SDK's form). A bare number elsewhere in a message is not a status.
// Literal patterns, one per status set (a RegExp built from a string is a
// Semgrep finding even when the string is a constant).
const STATUS_402 =
  /(?:returned|status(?: code)?|HTTP|code)[:\s]*402\b|\(402\)|^(?:\w*Error:\s*)?402\b/i;
const STATUS_429 =
  /(?:returned|status(?: code)?|HTTP|code)[:\s]*429\b|\(429\)|^(?:\w*Error:\s*)?429\b/i;
const STATUS_401_403 =
  /(?:returned|status(?: code)?|HTTP|code)[:\s]*(?:401|403)\b|\((?:401|403)\)|^(?:\w*Error:\s*)?(?:401|403)\b/i;

function readStatus(err: unknown): number | undefined {
  if (err && typeof err === "object" && "status" in err) {
    const s = (err as { status?: unknown }).status;
    if (typeof s === "number") return s;
  }
  return undefined;
}

function readCode(err: unknown): string | undefined {
  if (err && typeof err === "object" && "code" in err) {
    const c = (err as { code?: unknown }).code;
    if (typeof c === "string") return c;
  }
  return undefined;
}

function readSyscall(err: unknown): string | undefined {
  if (err && typeof err === "object" && "syscall" in err) {
    const s = (err as { syscall?: unknown }).syscall;
    if (typeof s === "string") return s;
  }
  return undefined;
}

/** How a request failed at the transport layer, when it did (#114). */
export type TransportFailure = "unreachable" | "slow" | "tls" | "dropped" | "closed";

// Connection-establishment failures: the host refused, does not resolve, has no
// route, or never answered the connect. ETIMEDOUT is here only when the error
// says it came from `connect` — a read-side ETIMEDOUT is a dead connection.
const CONNECT_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "EHOSTDOWN",
  "ENETUNREACH",
  "ENETDOWN",
  "UND_ERR_CONNECT_TIMEOUT",
]);
// undici's transport timeouts once connected: no headers / no further body.
const SLOW_CODES: ReadonlySet<string> = new Set([
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);
// OpenSSL verification codes Node surfaces on `err.code`.
const TLS_CODES: ReadonlySet<string> = new Set([
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "CERT_UNTRUSTED",
  "CERT_REVOKED",
  "HOSTNAME_MISMATCH",
]);
const TLS_CODE_PREFIX = /^(?:ERR_TLS_|ERR_SSL_)/;
// The connection existed and then died under the response.
const DROPPED_CODES: ReadonlySet<string> = new Set([
  "ECONNRESET",
  "EPIPE",
  "ECONNABORTED",
  "UND_ERR_SOCKET",
  "ETIMEDOUT",
]);

// METIS's own error codes (`AIError`, the budget enforcer) say nothing about the
// transport, so they neither decide nor block the text fallback. #152 — this
// includes the former `AI_PROVIDER_UNREACHABLE`, which nothing ever threw and
// which was removed from `AIErrorCode`.
function isMetisCode(code: string): boolean {
  return /^AI_/.test(code) || code === "BUDGET_EXCEEDED";
}

/**
 * #152 — undici's `fetch` rejects with `TypeError: fetch failed` when the
 * request failed before a response began, and errors the body with
 * `TypeError: terminated` once one had. (Measured on Node 22.22.3 against a
 * socket closed before and after the headers.)
 */
function isFetchFailedWrapper(e: unknown): boolean {
  return e instanceof TypeError && e.message === "fetch failed";
}

function classifyCode(code: string, e: unknown): TransportFailure | undefined {
  if (code === "ETIMEDOUT") {
    return readSyscall(e) === "connect" || /\bconnect ETIMEDOUT\b/.test(readMessage(e))
      ? "unreachable"
      : "dropped";
  }
  if (CONNECT_CODES.has(code)) return "unreachable";
  if (SLOW_CODES.has(code)) return "slow";
  if (TLS_CODES.has(code) || TLS_CODE_PREFIX.test(code)) return "tls";
  if (DROPPED_CODES.has(code)) return "dropped";
  return undefined;
}

// Text fallback, for stored strings and code-less errors only. #111's
// `FirstTokenTimeoutError` ("stream stalled — no first token within …") is the
// app-level form of the same slow-prefill case as undici's headers timeout.
const SLOW_TEXT =
  /\b(?:UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT)\b|\bHeaders Timeout Error\b|\bBody Timeout Error\b|\bstream stalled — no first token within\b/;
const TLS_TEXT =
  /\b(?:UNABLE_TO_VERIFY_LEAF_SIGNATURE|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|CERT_HAS_EXPIRED|ERR_TLS_CERT_ALTNAME_INVALID)\b|unable to verify the first certificate|self[- ]signed certificate|certificate has expired/i;
// `terminated` is undici's whole message for a body that died mid-stream; match
// it only as the entire message, never as a word inside other prose.
const DROPPED_TEXT =
  /\b(?:ECONNRESET|EPIPE)\b|\bsocket hang up\b|\bother side closed\b|^(?:TypeError:\s*)?terminated$/;
const UNREACHABLE_TEXT =
  /(?:^|[^\w])fetch failed\b|\b(?:ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|UND_ERR_CONNECT_TIMEOUT)\b|\bconnect ETIMEDOUT\b/;

/** `err` and up to two levels of `.cause` (undici nests the OS error). */
function causeChain(err: unknown): unknown[] {
  const chain: unknown[] = [];
  let e: unknown = err;
  for (let depth = 0; depth < 3 && e != null; depth++) {
    chain.push(e);
    e = typeof e === "object" && "cause" in e ? (e as { cause?: unknown }).cause : undefined;
  }
  return chain;
}

/**
 * #114 — classify a transport failure. When the error or any of its causes
 * carries a (non-METIS) code, the code alone decides: the FIRST recognised code
 * wins, and a chain carrying only unrecognised codes is not a transport verdict
 * at all. The text is read only when no code is present — a stored string, or an
 * error undici raised without one (`TypeError: terminated`).
 */
export function classifyTransportFailure(err: unknown): TransportFailure | undefined {
  const chain = causeChain(err);
  let sawCode = false;
  for (let i = 0; i < chain.length; i++) {
    const e = chain[i];
    const code = readCode(e);
    if (code === undefined || isMetisCode(code)) continue;
    sawCode = true;
    const verdict = classifyCode(code, e);
    // #152 — undici's socket close under `fetch failed` happened before any
    // response: not "dropped while the response was arriving". Deliberately
    // UND_ERR_SOCKET only: an ECONNRESET under `fetch failed` keeps its #114
    // "dropped" reading, which the local mid-stream retry keys on.
    if (code === "UND_ERR_SOCKET" && chain.slice(0, i).some(isFetchFailedWrapper)) {
      return "closed";
    }
    if (verdict) return verdict;
  }
  if (sawCode) return undefined;
  for (const e of chain) {
    const message = readMessage(e).trim();
    if (SLOW_TEXT.test(message)) return "slow";
    if (TLS_TEXT.test(message)) return "tls";
    if (DROPPED_TEXT.test(message)) return "dropped";
  }
  for (const e of chain) {
    if (UNREACHABLE_TEXT.test(readMessage(e))) return "unreachable";
  }
  return undefined;
}

/** True when `err` says the provider host could not be connected to. */
export function isProviderUnreachable(err: unknown): boolean {
  return classifyTransportFailure(err) === "unreachable";
}

/**
 * #114 — true when the connection was reset or closed while a response was
 * arriving. The docs-gen section loop retries a local section once on this
 * (see `generateSectionGroup`); a timeout or a refused connect is not a drop.
 */
export function isConnectionDropped(err: unknown): boolean {
  return classifyTransportFailure(err) === "dropped";
}

const TRANSPORT_MESSAGES: Readonly<Record<TransportFailure, string>> = {
  unreachable: GENERATION_PROVIDER_UNREACHABLE_MESSAGE,
  slow: GENERATION_PROVIDER_SLOW_MESSAGE,
  tls: GENERATION_PROVIDER_TLS_MESSAGE,
  dropped: GENERATION_PROVIDER_DROPPED_MESSAGE,
  closed: GENERATION_PROVIDER_CLOSED_MESSAGE,
};

function readMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === "string" ? err : "";
}

/**
 * The user-safe message to persist for a generation that threw `err`. Accepts a
 * stored string too, so a row written before #52 can be classified on read.
 */
export function generationFailureMessage(err: unknown): string {
  if (typeof err === "string" && SAFE_MESSAGES.has(err)) return err;
  const status = readStatus(err);
  const message = readMessage(err);

  if (readCode(err) === "BUDGET_EXCEEDED" || /monthly budget exceeded/i.test(message)) {
    return GENERATION_BUDGET_EXCEEDED_MESSAGE;
  }
  if (
    status === 402 ||
    STATUS_402.test(message) ||
    /insufficient[_\s-]*(?:balance|funds|credits?|quota)/i.test(message)
  ) {
    return GENERATION_PROVIDER_BALANCE_MESSAGE;
  }
  if (
    status === 429 ||
    readCode(err) === "AI_RATE_LIMITED" ||
    STATUS_429.test(message) ||
    /rate[_\s-]?limit|too many requests|ThrottlingException/i.test(message)
  ) {
    return GENERATION_PROVIDER_RATE_LIMITED_MESSAGE;
  }
  if (
    status === 401 ||
    status === 403 ||
    STATUS_401_403.test(message) ||
    /invalid[_\s-]*api[_\s-]*key|incorrect api key|authentication[_\s-]*error/i.test(message)
  ) {
    return GENERATION_PROVIDER_AUTH_MESSAGE;
  }
  const transport = classifyTransportFailure(err);
  if (transport) return TRANSPORT_MESSAGES[transport];
  return GENERATION_FAILED_MESSAGE;
}

/**
 * The `errorMessage` a client may see for a generated document.
 *
 * #86 — a non-`failed` row's message used to pass through VERBATIM on the
 * reasoning that a legacy `degraded` row carries pre-#252 warning JSON "which
 * METIS wrote itself". METIS *formatted* that blob, but the pre-#67
 * `sectionFailedWarning(label, String(err))` embedded the exception inside it,
 * and the UI's `resolveDocWarnings` legacy fallback parses and renders it — so
 * the exposure #52 closed for a `failed` row, and #67 closed for the `warnings`
 * column, survived here for every document generated before #252.
 *
 * Both arms now go through the fixed vocabulary:
 *
 * - a `failed` row's message → {@link generationFailureMessage}, as since #52;
 * - anything else → {@link legacyWarningJson}, which re-derives the detail of
 *   the embedded warnings through {@link publicDocWarnings} and collapses any
 *   other content to a fixed message.
 */
export function publicGenerationErrorMessage(
  status: string,
  errorMessage: string | null | undefined,
): string | null {
  if (errorMessage == null) return null;
  if (status !== "failed") return legacyWarningJson(errorMessage);
  return generationFailureMessage(errorMessage);
}

/**
 * #86 — sanitise the legacy `errorMessage` blob of a non-`failed` row.
 *
 * The shape is re-derived rather than trusted: pre-#252 rows hold `DocWarning[]`
 * JSON, which is handed to {@link publicDocWarnings} so each `section-failed`
 * warning's detail is re-classified exactly as the `warnings` column's is —
 * keeping the array parseable by the UI's legacy fallback, which drops any entry
 * without a string `message`. Anything else in that column (a raw exception
 * string a pre-#52 row left behind, a JSON object, `"null"`) is not a warning
 * list and cannot be repaired into one, so it collapses to the fixed vocabulary.
 */
function legacyWarningJson(errorMessage: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(errorMessage);
  } catch {
    return generationFailureMessage(errorMessage);
  }
  if (!Array.isArray(parsed)) return generationFailureMessage(errorMessage);
  return JSON.stringify(publicDocWarnings(parsed));
}

/**
 * #67 — the `warnings` a client may see for a generated document.
 *
 * A `section-failed` warning built before #67 appended up to 300 characters of
 * `String(err)` to its message, and that column is returned verbatim by
 * `GET /projects/:projectId/docs/:docId` and rendered by the UI banner — the
 * same exposure {@link publicGenerationErrorMessage} closes for a *failed*
 * row's `errorMessage`, on the *degraded* path. Those rows are still in the
 * database, so the read path re-derives their detail through
 * {@link generationFailureMessage}: a provider 402 stays recognisable as a
 * balance problem, anything unrecognised collapses to the generic message.
 *
 * A warning built by {@link sectionFailedWarning} carries `detailSafe`, so a
 * post-#67 warning is passed through with its METIS-authored detail intact
 * (the DB-schema synthesizer's "N of M tables described" text, for one). The
 * flag is the discriminator precisely because no pre-#67 row can have it.
 *
 * Every other warning kind is returned untouched: none of them is ever built
 * from an exception. The value is typed `unknown` because it comes off a Prisma
 * `Json?` column, and anything that is not an array of objects — `null`, the
 * pre-#252 string form — passes straight through.
 */
export function publicDocWarnings(warnings: unknown): unknown {
  if (!Array.isArray(warnings)) return warnings;
  return warnings.map((warning) => {
    if (warning == null || typeof warning !== "object" || Array.isArray(warning)) return warning;
    const w = warning as Record<string, unknown>;
    if (w.kind !== "section-failed" || w.detailSafe === true) return warning;
    const section = typeof w.section === "string" ? w.section : "Document";
    const raw = typeof w.message === "string" ? w.message : "";
    // Only the vocabulary's own output reaches the message; the legacy text is
    // read solely to CLASSIFY it, never echoed.
    const { message, detailSafe } = sectionFailedWarning(section, generationFailureMessage(raw));
    return { ...w, message, detailSafe };
  });
}
