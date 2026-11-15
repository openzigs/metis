"use client";

/**
 * Drag-and-drop document upload widget for a single project.
 *
 * - Validates client-side against MAX_DOCUMENT_BYTES + UPLOAD_MIME_ALLOWLIST
 *   so users get fast feedback without paying for a server round-trip.
 * - Uploads sequentially (one at a time) to keep things simple and to avoid
 *   stampeding the synchronous ingest pipeline.
 * - Surfaces per-file progress + ingest status using the document row
 *   returned by the API (status: pending|processing|ready|failed).
 * - #2555 — "Restrict to…" chooses who may read the files before they are
 *   sent: each is created with that access list, so it is never open to the
 *   whole project while it is indexed and reviewed.
 */
import { useCallback, useId, useRef, useState } from "react";
import {
  MAX_DOCUMENT_BYTES,
  UPLOAD_EXTENSION_ALLOWLIST,
  UPLOAD_MIME_ALLOWLIST,
} from "@metis/shared";
import { ApiError } from "@/lib/api-client";
import { unsupportedFileTypeMessage } from "@/lib/error-suggestion";
import {
  documentsApi,
  type AclSubject,
  type AclUserName,
  type DocumentRow,
} from "@/lib/projects-api";
import { aclSubjectLabel } from "@/lib/document-access";
import { useAuth } from "@/lib/auth-context";
import { Button } from "@/components/ui/button";
import { AclSubjectPicker } from "@/components/projects/acl-subject-picker";
import { aclLocksOut } from "@/components/projects/acl-editor";

interface QueueItem {
  id: string;
  file: File;
  status: "queued" | "uploading" | "done" | "error";
  message?: string;
  document?: DocumentRow;
}

interface Props {
  projectId: string;
  onUploaded?: (doc: DocumentRow) => void;
}

/**
 * The file picker's `accept`: the MIME allowlist plus each fallback extension
 * as `.ext` — a browser ignores a bare `md` (#1996). Shared with the governing upload.
 */
export const UPLOAD_ACCEPT = [
  ...(UPLOAD_MIME_ALLOWLIST as readonly string[]),
  ...(UPLOAD_EXTENSION_ALLOWLIST as readonly string[]).map((ext) => `.${ext}`),
].join(",");

/** The upload checks the server repeats; #1871 reuses them for governing documents. */
export function clientValidate(file: File): string | null {
  if (file.size === 0) return "File is empty";
  if (file.size > MAX_DOCUMENT_BYTES) {
    return `File exceeds the ${(MAX_DOCUMENT_BYTES / 1024 / 1024).toFixed(0)} MB cap`;
  }
  const mimeOk = (UPLOAD_MIME_ALLOWLIST as readonly string[]).includes(file.type);
  if (mimeOk) return null;
  const ext = file.name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (ext && (UPLOAD_EXTENSION_ALLOWLIST as readonly string[]).includes(ext)) return null;
  // SC 3.3.3 — the cause (wrong type) is known, so name the accepted formats.
  return unsupportedFileTypeMessage(UPLOAD_EXTENSION_ALLOWLIST);
}

/**
 * Issue #364 — what the queue row says once the upload is accepted. Ingest is
 * normally queued, so the response carries `queued · 0 chunks` while the list
 * below goes on to show the real chunk count; the row read "done — queued · 0
 * chunks" beside "awaiting review · 4 chunks". Only a synchronous ingest knows
 * its chunk count here, so only that one names it.
 */
export function uploadOutcomeMessage(ingest: { status: string; chunkCount: number }): string {
  if (ingest.status === "ready") {
    return `indexed · ${ingest.chunkCount} section${ingest.chunkCount === 1 ? "" : "s"}`;
  }
  if (ingest.status === "failed") return "indexing failed — see the document list";
  return "indexing in the background — the document list shows progress";
}

export function DocumentUploader({ projectId, onUploaded }: Props) {
  const [items, setItems] = useState<QueueItem[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const { user } = useAuth();
  const restrictId = useId();
  const [restrictOpen, setRestrictOpen] = useState(false);
  // #2555 — the list the next files are created with; empty = unrestricted.
  const [restrictTo, setRestrictTo] = useState<AclSubject[]>([]);
  const [people, setPeople] = useState<AclUserName[]>([]);

  const enqueue = useCallback(
    (files: FileList | File[]) => {
      const next: QueueItem[] = [];
      for (const f of Array.from(files)) {
        const reason = clientValidate(f);
        next.push({
          id: `${f.name}-${f.size}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          file: f,
          status: reason ? "error" : "queued",
          message: reason ?? undefined,
        });
      }
      setItems((prev) => [...prev, ...next]);
      // The list as it is when the files are chosen: a later edit restricts later files.
      void uploadAll(
        next.filter((i) => i.status === "queued"),
        restrictTo,
      );
    },
    [projectId, restrictTo],
  );

  async function uploadAll(queue: QueueItem[], aclSubjects: AclSubject[]) {
    for (const item of queue) {
      setItems((prev) => prev.map((q) => (q.id === item.id ? { ...q, status: "uploading" } : q)));
      try {
        const result = await documentsApi.upload(projectId, item.file, aclSubjects);
        setItems((prev) =>
          prev.map((q) =>
            q.id === item.id
              ? {
                  ...q,
                  status: "done",
                  document: result.document,
                  message: uploadOutcomeMessage(result.ingest),
                }
              : q,
          ),
        );
        onUploaded?.(result.document);
      } catch (err) {
        const message =
          err instanceof ApiError
            ? `${err.code ?? err.status}: ${err.message}`
            : err instanceof Error
              ? err.message
              : "Upload failed";
        setItems((prev) =>
          prev.map((q) => (q.id === item.id ? { ...q, status: "error", message } : q)),
        );
      }
    }
  }

  return (
    <section className="space-y-3" aria-label="Document uploader">
      <div
        role="button"
        tabIndex={0}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") inputRef.current?.click();
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (e.dataTransfer.files) enqueue(e.dataTransfer.files);
        }}
        className={`rounded-md border border-dashed p-8 text-center transition ${
          dragOver ? "border-primary bg-primary/5" : "border-muted-foreground/40"
        }`}
        data-testid="upload-dropzone"
      >
        <p className="text-sm font-medium">Drop files here, or click to browse</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Up to {(MAX_DOCUMENT_BYTES / 1024 / 1024).toFixed(0)} MB · md, txt, json, html, pdf, docx,
          xlsx, pptx
        </p>
        <input
          ref={inputRef}
          type="file"
          multiple
          className="hidden"
          accept={UPLOAD_ACCEPT}
          onChange={(e) => {
            if (e.target.files) enqueue(e.target.files);
            if (inputRef.current) inputRef.current.value = "";
          }}
          data-testid="upload-file-input"
        />
      </div>
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-expanded={restrictOpen}
            aria-controls={restrictId}
            onClick={() => setRestrictOpen((v) => !v)}
            data-testid="upload-restrict-toggle"
          >
            Restrict to…
          </Button>
          <p className="text-xs text-muted-foreground" data-testid="upload-restrict-summary">
            {restrictTo.length === 0
              ? "Files you add are readable by every project member."
              : `Files you add are readable only by ${restrictTo
                  .map((s) => aclSubjectLabel(s, people))
                  .join(", ")} and admins. Pasted text and links are not restricted by this list.`}
          </p>
        </div>
        {restrictOpen ? (
          <div id={restrictId} className="space-y-2 rounded-md border p-3">
            {restrictTo.length > 0 ? (
              <ul className="space-y-1" data-testid="upload-restrict-subjects">
                {restrictTo.map((s) => (
                  <li
                    key={`${s.kind}:${s.value}`}
                    className="flex items-center justify-between gap-2 rounded border px-2 py-1 text-xs"
                  >
                    <span>{aclSubjectLabel(s, people)}</span>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      aria-label={`Remove ${aclSubjectLabel(s, people)}`}
                      onClick={() =>
                        setRestrictTo(
                          restrictTo.filter((t) => !(t.kind === s.kind && t.value === s.value)),
                        )
                      }
                    >
                      Remove
                    </Button>
                  </li>
                ))}
              </ul>
            ) : null}
            <AclSubjectPicker
              projectId={projectId}
              idPrefix={`${restrictId}-upload`}
              chosen={restrictTo}
              onAdd={(subject, person) => {
                setRestrictTo([...restrictTo, subject]);
                if (person) setPeople([...people.filter((p) => p.id !== person.id), person]);
              }}
            />
          </div>
        ) : null}
        {/* Beside the summary, open or collapsed: the files are dropped with the panel shut. */}
        {aclLocksOut(restrictTo, user) ? (
          <p className="text-xs text-warning" role="status" data-testid="upload-restrict-lockout">
            You are not on this list: you will not be able to read the files you add or change who
            can. Add yourself or your role to keep access.
          </p>
        ) : null}
      </div>
      {items.length > 0 ? (
        <ul className="space-y-2" data-testid="upload-queue">
          {items.map((item) => (
            <li
              key={item.id}
              className="flex items-center justify-between rounded-md border p-2 text-sm"
            >
              <div>
                <span className="font-medium">{item.file.name}</span>
                <span className="ml-2 text-xs text-muted-foreground">
                  {(item.file.size / 1024).toFixed(1)} KB
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span
                  className={`text-xs ${
                    item.status === "error"
                      ? "text-destructive"
                      : item.status === "done"
                        ? "text-success"
                        : "text-muted-foreground"
                  }`}
                  data-testid={`upload-status-${item.status}`}
                >
                  {item.status === "done" ? "uploaded" : item.status}
                  {item.message ? ` — ${item.message}` : ""}
                </span>
              </div>
            </li>
          ))}
          <li>
            <Button variant="ghost" size="sm" onClick={() => setItems([])}>
              Clear list
            </Button>
          </li>
        </ul>
      ) : null}
    </section>
  );
}
