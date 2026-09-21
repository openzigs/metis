"use client";

/**
 * Epic #165 / Issue #123 — Plugins import/export manager.
 *
 * Lets a user select skills / custom agents / hooks and download a
 * `metis-plugin-*.json` envelope, and upload an envelope to import it into the
 * current project. Surfaces parsed, human-readable errors (never a raw JSON
 * blob) and a success summary of imported items.
 *
 * Provider guardrail: operates on skills/agents/hooks definitions only — no
 * provider routing changes for Bedrock or local-gemma.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ApiError } from "@/lib/api-client";
import { skillsApi } from "@/lib/library-api";
import { sdkApi } from "@/lib/sdk-alignment-api";
import { pluginsApi, triggerDownload, type PluginImportResult } from "@/lib/plugins-api";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface Props {
  projectId: string;
}

function toggle(set: Set<string>, id: string): Set<string> {
  const next = new Set(set);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

export function PluginsManager({ projectId }: Props) {
  const skills = useQuery({
    queryKey: ["plugins", "skills"],
    queryFn: () => skillsApi.list(),
  });
  const agents = useQuery({
    queryKey: ["plugins", "agents", projectId],
    queryFn: () => sdkApi.listAgents(projectId, false),
    enabled: Boolean(projectId),
  });
  const hooks = useQuery({
    queryKey: ["plugins", "hooks", projectId],
    queryFn: () => sdkApi.listHooks(projectId),
    enabled: Boolean(projectId),
  });

  const [name, setName] = useState("");
  const [version, setVersion] = useState("1.0.0");
  const [description, setDescription] = useState("");
  const [skillIds, setSkillIds] = useState<Set<string>>(new Set());
  const [agentIds, setAgentIds] = useState<Set<string>>(new Set());
  const [hookIds, setHookIds] = useState<Set<string>>(new Set());

  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<PluginImportResult | null>(null);

  const nameValid = useMemo(() => /^[a-z][a-z0-9-]+$/.test(name), [name]);

  const skillItems = skills.data?.items ?? [];
  const agentItems = agents.data ?? [];
  const hookItems = hooks.data ?? [];

  async function handleExport() {
    setExportError(null);
    if (!nameValid) {
      setExportError("Plugin name must be lowercase letters, digits, and dashes.");
      return;
    }
    setExporting(true);
    try {
      const { blob, filename } = await pluginsApi.exportPlugin({
        name,
        version,
        description: description.trim() || undefined,
        skillIds: [...skillIds],
        customAgentIds: [...agentIds],
        hookIds: [...hookIds],
      });
      triggerDownload(blob, filename);
    } catch (err) {
      setExportError(err instanceof Error ? err.message : "Export failed");
    } finally {
      setExporting(false);
    }
  }

  async function handleImportFile(file: File) {
    setImportError(null);
    setImportResult(null);
    setImporting(true);
    try {
      const text = await file.text();
      let envelope: unknown;
      try {
        envelope = JSON.parse(text);
      } catch {
        throw new Error("Selected file is not valid JSON.");
      }
      const result = await pluginsApi.importPlugin(projectId, envelope);
      setImportResult(result);
    } catch (err) {
      setImportError(
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Import failed",
      );
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className="space-y-6" data-testid="plugins-manager">
      {/* ── Export ─────────────────────────────────────────────────────── */}
      <Card className="space-y-4 p-4" data-testid="plugins-export">
        <div>
          <h2 className="text-lg font-semibold">Export plugin</h2>
          <p className="text-sm text-muted-foreground">
            Select skills, agents, and hooks to bundle into a downloadable
            <code className="mx-1">metis-plugin-*.json</code> envelope.
          </p>
        </div>

        <div className="flex flex-wrap gap-3">
          <div className="space-y-1">
            <Label htmlFor="plugin-name">Name</Label>
            <Input
              id="plugin-name"
              data-testid="plugin-name"
              placeholder="my-plugin"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="plugin-version">Version</Label>
            <Input
              id="plugin-version"
              data-testid="plugin-version"
              value={version}
              onChange={(e) => setVersion(e.target.value)}
            />
          </div>
          <div className="flex-1 space-y-1">
            <Label htmlFor="plugin-description">Description</Label>
            <Input
              id="plugin-description"
              data-testid="plugin-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
        </div>

        <fieldset className="space-y-2" data-testid="plugin-skills">
          <legend className="text-sm font-medium">Skills</legend>
          {skillItems.length > 0 ? (
            skillItems.map((s) => (
              <label key={s.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={skillIds.has(s.id)}
                  onChange={() => setSkillIds((prev) => toggle(prev, s.id))}
                  aria-label={`Skill ${s.name}`}
                />
                <span>{s.name}</span>
              </label>
            ))
          ) : (
            <p className="text-xs text-muted-foreground">No skills available.</p>
          )}
        </fieldset>

        <fieldset className="space-y-2" data-testid="plugin-agents">
          <legend className="text-sm font-medium">Custom agents</legend>
          {agentItems.length > 0 ? (
            agentItems.map((a) => (
              <label key={a.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={agentIds.has(a.id)}
                  onChange={() => setAgentIds((prev) => toggle(prev, a.id))}
                  aria-label={`Agent ${a.name}`}
                />
                <span>{a.name}</span>
              </label>
            ))
          ) : (
            <p className="text-xs text-muted-foreground">No custom agents available.</p>
          )}
        </fieldset>

        <fieldset className="space-y-2" data-testid="plugin-hooks">
          <legend className="text-sm font-medium">Hooks</legend>
          {hookItems.length > 0 ? (
            hookItems.map((h) => (
              <label key={h.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={hookIds.has(h.id)}
                  onChange={() => setHookIds((prev) => toggle(prev, h.id))}
                  aria-label={`Hook ${h.event}`}
                />
                <span>
                  {h.event} · {h.handlerKind}
                </span>
              </label>
            ))
          ) : (
            <p className="text-xs text-muted-foreground">No hooks available.</p>
          )}
        </fieldset>

        <Button
          type="button"
          onClick={handleExport}
          disabled={exporting}
          data-testid="plugin-export-button"
        >
          {exporting ? "Exporting…" : "Export & download"}
        </Button>
        {exportError ? (
          <p className="text-sm text-destructive" role="alert" data-testid="plugin-export-error">
            {exportError}
          </p>
        ) : null}
      </Card>

      {/* ── Import ─────────────────────────────────────────────────────── */}
      <Card className="space-y-4 p-4" data-testid="plugins-import">
        <div>
          <h2 className="text-lg font-semibold">Import plugin</h2>
          <p className="text-sm text-muted-foreground">
            Upload a <code>metis-plugin-*.json</code> envelope to register its skills, agents, and
            hooks into this project.
          </p>
        </div>

        <div className="space-y-1">
          <Label htmlFor="plugin-import-file">Plugin file</Label>
          <input
            id="plugin-import-file"
            data-testid="plugin-import-file"
            type="file"
            accept="application/json,.json"
            disabled={importing}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleImportFile(file);
            }}
          />
        </div>

        {importing ? (
          <p className="text-sm text-muted-foreground" data-testid="plugin-import-pending">
            Importing…
          </p>
        ) : null}

        {importResult ? (
          <div
            className="rounded-md border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900"
            role="status"
            data-testid="plugin-import-success"
          >
            Imported <strong>{importResult.manifest.name}</strong> v{importResult.manifest.version}:{" "}
            {importResult.installed.skills} skill(s), {importResult.installed.agents} agent(s),{" "}
            {importResult.installed.hooks} hook(s).
          </div>
        ) : null}

        {importError ? (
          <p className="text-sm text-destructive" role="alert" data-testid="plugin-import-error">
            {importError}
          </p>
        ) : null}
      </Card>
    </div>
  );
}
