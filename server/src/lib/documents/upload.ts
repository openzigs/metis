/**
 * Upload validation (Phase 5 / issue #39).
 *
 * - Enforces the `MAX_DOCUMENT_BYTES` size cap (returns 413).
 * - Enforces the MIME allowlist (`UPLOAD_MIME_ALLOWLIST`) with a magic-byte
 *   double-check for binary types (returns 415).
 * - Sanitises the filename — we never echo a client-supplied filename into
 *   the filesystem; only the trimmed/sanitised version is persisted in the
 *   `Document.filename` column for display purposes.
 */
import path from "node:path";
import {
  MAX_DOCUMENT_BYTES,
  UPLOAD_EXTENSION_ALLOWLIST,
  UPLOAD_MIME_ALLOWLIST,
} from "@metis/shared";
import { contentMatchesDeclaredMime, requiredContentFamily } from "./content-signature.js";

export interface UploadCandidate {
  filename: string;
  mimeType: string;
  buffer: Buffer;
}

export type UploadValidation =
  | { ok: true; mimeType: string; filename: string }
  | { ok: false; status: 413 | 415 | 400; code: string; message: string };

export function validateUpload(input: UploadCandidate): UploadValidation {
  if (!input.buffer || input.buffer.length === 0) {
    return { ok: false, status: 400, code: "EMPTY_FILE", message: "File is empty" };
  }
  if (input.buffer.length > MAX_DOCUMENT_BYTES) {
    return {
      ok: false,
      status: 413,
      code: "FILE_TOO_LARGE",
      message: `File exceeds ${MAX_DOCUMENT_BYTES} byte limit`,
    };
  }
  const filename = sanitiseFilename(input.filename);
  if (filename.length === 0) {
    return { ok: false, status: 400, code: "INVALID_FILENAME", message: "Invalid filename" };
  }
  const reserved = reservedFilenamePrefix(filename);
  if (reserved) {
    return {
      ok: false,
      status: 400,
      code: "RESERVED_FILENAME",
      message: `Filenames starting with '${reserved}' are reserved for connector and generated documents; rename the file and upload it again`,
    };
  }
  const allow = UPLOAD_MIME_ALLOWLIST as readonly string[];
  let mime = (input.mimeType ?? "").toLowerCase();
  if (!allow.includes(mime)) {
    // Browsers occasionally send `application/octet-stream` for known formats.
    // Fall back to extension sniffing against the same allowlist.
    const ext = filename.toLowerCase().split(".").pop() ?? "";
    if ((UPLOAD_EXTENSION_ALLOWLIST as readonly string[]).includes(ext)) {
      mime = mimeForExtension(ext);
    } else {
      return {
        ok: false,
        status: 415,
        code: "MIME_NOT_ALLOWED",
        message: `Content type '${input.mimeType}' is not in the allowlist`,
      };
    }
  }
  if (!magicByteOk(mime, input.buffer)) {
    return {
      ok: false,
      status: 415,
      code: "MAGIC_BYTE_MISMATCH",
      message: `File contents do not match advertised MIME type ${mime}`,
    };
  }
  return { ok: true, mimeType: mime, filename };
}

/**
 * Issue #525 — filename prefixes that connector and generated-document writers
 * use. Code-symbol dedup, grounding, the document lists (#547) and citation
 * labels (#573) classify on `documents.source`; a citation whose document no
 * longer resolves still falls back to its name, so an upload may not carry
 * one. Each prefix is matched the way its readers match
 * it: case-sensitively, except `generated-doc-`, which `doc-label.ts` matches
 * with `/i` (see {@link CASE_INSENSITIVE_RESERVED_PREFIXES}). A pasted title
 * such as `Jira: sprint 12 retro.md` reaches no reader's pattern, so it stays
 * an ordinary upload.
 *
 * - `connector:`     repository and database connectors (`connector-ingest.ts`)
 * - `repo:`          the legacy repository shape (`fused-code-context.ts`)
 * - `jira:`, `confluence:` the Atlassian connector (`atlassian.ts`)
 * - `generated-doc-` a published generated document (`generated-doc-publication.ts`)
 * - `live-schema:`   the analysis database agent's schema citation
 *                    (`analysis/schema-context.ts`); the UI labels it "Live schema"
 */
export const RESERVED_FILENAME_PREFIXES = [
  "connector:",
  "repo:",
  "jira:",
  "confluence:",
  "generated-doc-",
  "live-schema:",
] as const;

/** Reserved prefixes some reader matches case-insensitively. */
const CASE_INSENSITIVE_RESERVED_PREFIXES: ReadonlySet<string> = new Set(["generated-doc-"]);

/** The reserved prefix `filename` starts with, or null. */
export function reservedFilenamePrefix(filename: string): string | null {
  const lower = filename.toLowerCase();
  return (
    RESERVED_FILENAME_PREFIXES.find((prefix) =>
      CASE_INSENSITIVE_RESERVED_PREFIXES.has(prefix)
        ? lower.startsWith(prefix)
        : filename.startsWith(prefix),
    ) ?? null
  );
}

/**
 * Strip directory components, control characters, and double-dot segments.
 * Result is a safe display string — it does NOT inform on-disk paths
 * (those are content-hash based, see `documents/storage.ts`).
 */
export function sanitiseFilename(raw: string): string {
  if (typeof raw !== "string") return "";
  const base = path.basename(raw);
  const cleaned = base
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/[\\/]+/g, "_")
    .replace(/\.\.+/g, ".")
    .trim();
  return cleaned.slice(0, 255);
}

function mimeForExtension(ext: string): string {
  switch (ext) {
    case "md":
    case "markdown":
      return "text/markdown";
    case "txt":
      return "text/plain";
    case "html":
    case "htm":
      return "text/html";
    case "json":
      return "application/json";
    case "pdf":
      return "application/pdf";
    case "docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case "xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case "pptx":
      // `pptx` is in UPLOAD_EXTENSION_ALLOWLIST but was missing here, so an
      // octet-stream `.pptx` was admitted and stored as `application/octet-stream` —
      // skipping the signature check below, which keys off the resolved MIME (#1279).
      return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    default:
      return "application/octet-stream";
  }
}

/**
 * Admission control for the HTTP boundary (415). It shares its signature predicate with
 * the parser router (`content-signature.ts`) so the two cannot drift: the router's job is
 * to decide which parser runs, this one's is to refuse the request outright. Before #1279
 * this switch had no `presentationml.presentation` case, so PDF bytes labelled `.pptx`
 * fell through `default` and were admitted.
 */
function magicByteOk(mime: string, buf: Buffer): boolean {
  if (buf.length < 4) return mime.startsWith("text/") || mime === "application/json";
  if (requiredContentFamily(mime) !== null) {
    return contentMatchesDeclaredMime(mime, buf);
  }
  // Text / json / markdown / html: we already trust the allowlist + we will
  // toString utf8 downstream. Reject NUL bytes which indicate binary content
  // mislabelled as text.
  if (mime.startsWith("text/") || mime === "application/json") {
    for (let i = 0; i < Math.min(buf.length, 1024); i += 1) {
      if (buf[i] === 0) return false;
    }
    return true;
  }
  return true;
}
