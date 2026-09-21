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
 */
import { useCallback, useRef, useState } from "react";
import {
  MAX_DOCUMENT_BYTES,
  UPLOAD_EXTENSION_ALLOWLIST,
  UPLOAD_MIME_ALLOWLIST,
} from "@metis/shared";
import { ApiError } from "@/lib/api-client";
import { unsupportedFileTypeMessage } from "@/lib/error-suggestion";
import { documentsApi, type DocumentRow } from "@/lib/projects-api";
import { Button } from "@/components/ui/button";

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

function clientValidate(file: File): string | null {
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

export function DocumentUploader({ projectId, onUploaded }: Props) {
  const [items, setItems] = useState<QueueItem[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

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
      void uploadAll(next.filter((i) => i.status === "queued"));
    },
    [projectId],
  );

  async function uploadAll(queue: QueueItem[]) {
    for (const item of queue) {
      setItems((prev) => prev.map((q) => (q.id === item.id ? { ...q, status: "uploading" } : q)));
      try {
        const result = await documentsApi.upload(projectId, item.file);
        setItems((prev) =>
          prev.map((q) =>
            q.id === item.id
              ? {
                  ...q,
                  status: "done",
                  document: result.document,
                  message: `${result.ingest.status} · ${result.ingest.chunkCount} chunks`,
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
          accept={[
            ...(UPLOAD_MIME_ALLOWLIST as readonly string[]),
            ...(UPLOAD_EXTENSION_ALLOWLIST as readonly string[]),
          ].join(",")}
          onChange={(e) => {
            if (e.target.files) enqueue(e.target.files);
            if (inputRef.current) inputRef.current.value = "";
          }}
          data-testid="upload-file-input"
        />
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
                        ? "text-green-600 dark:text-green-400"
                        : "text-muted-foreground"
                  }`}
                  data-testid={`upload-status-${item.status}`}
                >
                  {item.status}
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
