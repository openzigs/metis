/**
 * Plugins import/export API client (Epic #165 / Issue #82, UI consumer #123).
 *
 * Wraps:
 *   POST /api/plugins/export  → streams a `metis-plugin-*.json` envelope
 *   POST /api/plugins/import  → consumes an envelope, registers items
 *
 * Export returns a raw JSON envelope (NOT the `{ success, data }` wrapper), so
 * it is fetched via {@link streamFetch} and read as a blob for download. Import
 * uses {@link apiFetch} which surfaces a parsed error message on failure.
 *
 * Plugin import/export only moves skills/agents/hooks definitions — it does not
 * touch provider routing for Bedrock or local-gemma.
 */
import { apiFetch, streamFetch } from "@/lib/api-client";

export interface PluginExportInput {
  name: string;
  version: string;
  description?: string;
  skillIds?: string[];
  customAgentIds?: string[];
  hookIds?: string[];
}

export interface PluginImportResult {
  manifest: { name: string; version: string; description: string };
  installed: { skills: number; agents: number; hooks: number };
}

export interface PluginExportDownload {
  blob: Blob;
  filename: string;
}

export async function parseStreamError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as {
      error?: { message?: string };
      message?: string;
    };
    return body?.error?.message ?? body?.message ?? res.statusText ?? "Export failed";
  } catch {
    return res.statusText || "Export failed";
  }
}

export function filenameFromDisposition(header: string | null, fallback: string): string {
  if (!header) return fallback;
  const match = /filename="?([^"]+)"?/.exec(header);
  return match?.[1] ?? fallback;
}

export const pluginsApi = {
  /**
   * Build and download a plugin envelope. Returns the blob + suggested
   * filename so the caller can trigger a browser download (kept separate so it
   * is unit-testable without a DOM).
   */
  async exportPlugin(input: PluginExportInput): Promise<PluginExportDownload> {
    const res = await streamFetch("/plugins/export", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      throw new Error(await parseStreamError(res));
    }
    const blob = await res.blob();
    const filename = filenameFromDisposition(
      res.headers.get("content-disposition"),
      `metis-plugin-${input.name}.json`,
    );
    return { blob, filename };
  },

  importPlugin(projectId: string, envelope: unknown): Promise<PluginImportResult> {
    return apiFetch<PluginImportResult>("/plugins/import", {
      method: "POST",
      body: { projectId, envelope },
    });
  },
};

/** Trigger a browser download for a blob via a transient object URL. */
export function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
