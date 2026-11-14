"use client";

/**
 * #1871 — upload a governing document, or a new revision of one.
 *
 * The file goes through the project uploader's own checks (`clientValidate`:
 * the same size cap and type allowlist, with the same messages) before any
 * request; the server repeats them. On success the list query is invalidated,
 * so what the list then shows is what the server stored.
 */
import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { MAX_DOCUMENT_BYTES, UPLOAD_EXTENSION_ALLOWLIST } from "@metis/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { UPLOAD_ACCEPT, clientValidate } from "@/components/projects/document-uploader";
import { resolveErrorMessage } from "@/lib/use-app-mutation";
import { governingApi, governingKeys } from "@/lib/governing-api";

/** A new document, or a new revision of an existing one. */
export type UploadTarget =
  { kind: "document" } | { kind: "revision"; documentId: string; title: string };

interface Props {
  workspaceId: string;
  target: UploadTarget | null;
  onClose: () => void;
}

/**
 * #2220 — what the form still needs before Upload is enabled, in form order.
 * Upload stayed disabled with no hint, and nothing marked the revision label
 * and effective date as required.
 */
export function missingUploadFields(form: {
  file: File | null;
  fileError: string | null;
  title: string;
  revisionLabel: string;
  effectiveDate: string;
  isRevision: boolean;
}): string[] {
  const missing: string[] = [];
  if (form.file === null || form.fileError !== null) missing.push("a file");
  if (!form.isRevision && form.title.trim() === "") missing.push("a title");
  if (form.revisionLabel.trim() === "") missing.push("a revision label");
  if (form.effectiveDate === "") missing.push("an effective date");
  return missing;
}

/** "a, b and c". */
function listText(items: readonly string[]): string {
  return items.length <= 1
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** The marker on a required field's label. */
function Required() {
  return <span className="text-muted-foreground"> (required)</span>;
}

export function GoverningUploadDialog({ workspaceId, target, onClose }: Props) {
  return (
    <Dialog open={target !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent>
        {target ? (
          <UploadForm
            key={target.kind === "revision" ? target.documentId : "new"}
            workspaceId={workspaceId}
            target={target}
            onClose={onClose}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function UploadForm({
  workspaceId,
  target,
  onClose,
}: {
  workspaceId: string;
  target: UploadTarget;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [framework, setFramework] = useState("");
  const [revisionLabel, setRevisionLabel] = useState("");
  const [effectiveDate, setEffectiveDate] = useState("");

  const upload = useMutation({
    mutationFn: () => {
      if (!file) throw new Error("Choose a file");
      return target.kind === "revision"
        ? governingApi.addRevision(workspaceId, target.documentId, {
            file,
            revisionLabel: revisionLabel.trim(),
            effectiveDate,
          })
        : governingApi.upload(workspaceId, {
            file,
            title: title.trim(),
            revisionLabel: revisionLabel.trim(),
            effectiveDate,
            framework: framework.trim() || undefined,
          });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: governingKeys.all(workspaceId) });
      onClose();
    },
  });

  const isRevision = target.kind === "revision";
  const missing = missingUploadFields({
    file,
    fileError,
    title,
    revisionLabel,
    effectiveDate,
    isRevision,
  });
  const ready = missing.length === 0;

  function submit(e: FormEvent) {
    e.preventDefault();
    if (ready) upload.mutate();
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <DialogHeader>
        <DialogTitle>
          {isRevision ? `New revision of ${target.title}` : "Upload a governing document"}
        </DialogTitle>
        <DialogDescription>
          Up to {(MAX_DOCUMENT_BYTES / 1024 / 1024).toFixed(0)} MB ·{" "}
          {UPLOAD_EXTENSION_ALLOWLIST.join(", ")}. Its rules are extracted after the upload.
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-2">
        <Label htmlFor="governing-file">
          File
          <Required />
        </Label>
        <Input
          id="governing-file"
          type="file"
          aria-invalid={fileError !== null}
          aria-describedby={fileError ? "governing-file-error" : undefined}
          accept={UPLOAD_ACCEPT}
          onChange={(e) => {
            const chosen = e.target.files?.[0] ?? null;
            setFile(chosen);
            setFileError(chosen ? clientValidate(chosen) : null);
          }}
        />
        {fileError ? (
          <p id="governing-file-error" role="alert" className="text-sm text-destructive">
            {fileError}
          </p>
        ) : null}
      </div>

      {isRevision ? null : (
        <>
          <div className="space-y-2">
            <Label htmlFor="governing-title">
              Title
              <Required />
            </Label>
            <Input
              id="governing-title"
              required
              maxLength={300}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="governing-framework">Framework (optional)</Label>
            <Input
              id="governing-framework"
              maxLength={200}
              value={framework}
              onChange={(e) => setFramework(e.target.value)}
              placeholder="ISO 27001"
            />
          </div>
        </>
      )}

      <div className="flex gap-3">
        <div className="flex-1 space-y-2">
          <Label htmlFor="governing-revision-label">
            Revision label
            <Required />
          </Label>
          <Input
            id="governing-revision-label"
            required
            maxLength={64}
            value={revisionLabel}
            onChange={(e) => setRevisionLabel(e.target.value)}
            placeholder="v1"
          />
        </div>
        <div className="flex-1 space-y-2">
          <Label htmlFor="governing-effective-date">
            Effective date
            <Required />
          </Label>
          <Input
            id="governing-effective-date"
            type="date"
            required
            value={effectiveDate}
            onChange={(e) => setEffectiveDate(e.target.value)}
          />
        </div>
      </div>

      {upload.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {resolveErrorMessage(upload.error, "Upload failed")}
        </p>
      ) : null}

      {ready ? null : (
        <p
          id="governing-upload-missing"
          className="text-xs text-muted-foreground"
          data-testid="governing-upload-missing"
        >
          To upload, add {listText(missing)}.
        </p>
      )}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button
          type="submit"
          disabled={!ready || upload.isPending}
          aria-describedby={ready ? undefined : "governing-upload-missing"}
        >
          {upload.isPending ? "Uploading…" : "Upload"}
        </Button>
      </DialogFooter>
    </form>
  );
}
