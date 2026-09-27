"use client";

/**
 * Template editor settings page — Epic #595 / Issue #614.
 *
 * Lists all issue templates for a project. Supports create, edit,
 * clone, delete, and live preview.
 */
import { useParams } from "next/navigation";
import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  templatesApi,
  type TemplateData,
  type TemplateSchemaData,
  type TemplateSectionData,
  type CreateTemplateInput,
} from "@/lib/templates-api";
import { queryKeys } from "@/lib/query-keys";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/ui/page-header";

const SECTION_TYPES = ["text", "markdown", "checklist", "number", "select", "tags"] as const;
const PLATFORMS = ["github", "jira", "universal"] as const;
const TEMPLATE_TYPES = ["epic", "feature", "story", "bug", "task"] as const;

function parseSchema(raw: string): TemplateSchemaData | null {
  try {
    return JSON.parse(raw) as TemplateSchemaData;
  } catch {
    return null;
  }
}

// ── Preview Component ──────────────────────────────────────────────────

function TemplatePreview({
  schema,
  previewMode,
}: {
  schema: TemplateSchemaData;
  previewMode: "github" | "jira";
}) {
  return (
    <div className="rounded-lg border border-border bg-muted p-4 text-sm">
      <div className="mb-2 text-xs font-medium text-muted-foreground uppercase">
        {previewMode === "github" ? "GitHub Markdown" : "Jira"} Preview
      </div>
      {schema.sections.map((s) => (
        <div key={s.key} className="mb-3">
          {s.key !== "title" && (
            <h3 className="text-sm font-semibold text-foreground mb-1">
              {previewMode === "github" ? `## ${s.label}` : `h3. ${s.label}`}
            </h3>
          )}
          <div className="text-muted-foreground italic text-xs">
            {s.placeholder || `[${s.type}${s.required ? ", required" : ""}]`}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Section Editor Component ───────────────────────────────────────────

function SectionEditor({
  section,
  onUpdate,
  onRemove,
}: {
  section: TemplateSectionData;
  onUpdate: (updated: TemplateSectionData) => void;
  onRemove: () => void;
}) {
  return (
    <div className="rounded border border-border bg-muted/50 p-3 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-foreground">{section.label || section.key}</span>
        <button
          onClick={onRemove}
          className="text-xs text-destructive hover:text-destructive"
          aria-label={`Remove section ${section.key}`}
        >
          Remove
        </button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <Label className="text-xs text-muted-foreground">Key</Label>
          <input
            type="text"
            value={section.key}
            onChange={(e) => onUpdate({ ...section, key: e.target.value })}
            className="w-full rounded bg-muted border border-border px-2 py-1 text-sm text-foreground"
            aria-label="Section key"
          />
        </div>
        <div>
          <Label className="text-xs text-muted-foreground">Label</Label>
          <input
            type="text"
            value={section.label}
            onChange={(e) => onUpdate({ ...section, label: e.target.value })}
            className="w-full rounded bg-muted border border-border px-2 py-1 text-sm text-foreground"
            aria-label="Section label"
          />
        </div>
        <div>
          <Label className="text-xs text-muted-foreground">Type</Label>
          <select
            value={section.type}
            onChange={(e) =>
              onUpdate({ ...section, type: e.target.value as TemplateSectionData["type"] })
            }
            className="w-full rounded bg-muted border border-border px-2 py-1 text-sm text-foreground"
            aria-label="Section type"
          >
            {SECTION_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-2 pt-5">
          <input
            type="checkbox"
            checked={section.required}
            onChange={(e) => onUpdate({ ...section, required: e.target.checked })}
            className="rounded"
            id={`required-${section.key}`}
            aria-label="Required"
          />
          <Label htmlFor={`required-${section.key}`} className="text-xs text-muted-foreground">
            Required
          </Label>
        </div>
      </div>
      <div>
        <Label className="text-xs text-muted-foreground">Placeholder</Label>
        <input
          type="text"
          value={section.placeholder || ""}
          onChange={(e) => onUpdate({ ...section, placeholder: e.target.value || undefined })}
          className="w-full rounded bg-muted border border-border px-2 py-1 text-sm text-foreground"
          aria-label="Section placeholder"
        />
      </div>
    </div>
  );
}

// ── Template Form (create/edit) ────────────────────────────────────────

function TemplateForm({
  initial,
  onSave,
  onCancel,
  saving,
}: {
  initial?: TemplateSchemaData;
  onSave: (schema: TemplateSchemaData, name: string) => void;
  onCancel: () => void;
  saving: boolean;
}) {
  const [name, setName] = useState(initial?.name || "");
  const [platform, setPlatform] = useState<TemplateSchemaData["platform"]>(
    initial?.platform || "github",
  );
  const [templateType, setTemplateType] = useState<TemplateSchemaData["templateType"]>(
    initial?.templateType || "feature",
  );
  const [sections, setSections] = useState<TemplateSectionData[]>(
    initial?.sections || [
      { key: "title", label: "Title", type: "text", required: true },
      { key: "description", label: "Description", type: "markdown", required: true },
    ],
  );
  const [previewMode, setPreviewMode] = useState<"github" | "jira">("github");

  const schema = useMemo<TemplateSchemaData>(
    () => ({ name, platform, templateType, sections }),
    [name, platform, templateType, sections],
  );

  function addSection() {
    const key = `section_${sections.length + 1}`;
    setSections([...sections, { key, label: "New Section", type: "text", required: false }]);
  }

  function updateSection(index: number, updated: TemplateSectionData) {
    setSections(sections.map((s, i) => (i === index ? updated : s)));
  }

  function removeSection(index: number) {
    setSections(sections.filter((_, i) => i !== index));
  }

  return (
    <div className="space-y-6">
      {/* Meta fields */}
      <div className="grid grid-cols-3 gap-4">
        <div>
          <Label className="text-sm text-foreground">Template Name</Label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded bg-muted border border-border px-3 py-2 text-sm text-foreground"
            placeholder="My Template"
            aria-label="Template name"
          />
        </div>
        <div>
          <Label className="text-sm text-foreground">Platform</Label>
          <select
            value={platform}
            onChange={(e) => setPlatform(e.target.value as TemplateSchemaData["platform"])}
            className="w-full rounded bg-muted border border-border px-3 py-2 text-sm text-foreground"
            aria-label="Platform"
          >
            {PLATFORMS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </div>
        <div>
          <Label className="text-sm text-foreground">Template Type</Label>
          <select
            value={templateType}
            onChange={(e) => setTemplateType(e.target.value as TemplateSchemaData["templateType"])}
            className="w-full rounded bg-muted border border-border px-3 py-2 text-sm text-foreground"
            aria-label="Template type"
          >
            {TEMPLATE_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Sections + Preview side-by-side */}
      <div className="grid grid-cols-2 gap-6">
        {/* Section editor */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-foreground">Sections</h3>
            <Button onClick={addSection} variant="outline" size="sm">
              + Add Section
            </Button>
          </div>
          {sections.map((section, i) => (
            <SectionEditor
              key={`${section.key}-${i}`}
              section={section}
              onUpdate={(s) => updateSection(i, s)}
              onRemove={() => removeSection(i)}
            />
          ))}
        </div>

        {/* Live preview */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-foreground">Preview</h3>
            <div className="flex gap-1">
              <button
                onClick={() => setPreviewMode("github")}
                className={`px-2 py-1 text-xs rounded ${
                  previewMode === "github"
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                GitHub
              </button>
              <button
                onClick={() => setPreviewMode("jira")}
                className={`px-2 py-1 text-xs rounded ${
                  previewMode === "jira"
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                Jira
              </button>
            </div>
          </div>
          <TemplatePreview schema={schema} previewMode={previewMode} />
        </div>
      </div>

      {/* Actions */}
      <div className="flex gap-3 pt-4 border-t border-border">
        <Button onClick={() => onSave(schema, name)} disabled={saving || !name.trim()}>
          {saving ? "Saving…" : "Save Template"}
        </Button>
        <Button onClick={onCancel} variant="outline">
          Cancel
        </Button>
      </div>
    </div>
  );
}

// ── Main Page Component ────────────────────────────────────────────────

export default function TemplateSettingsPage() {
  const params = useParams<{ id: string }>();
  const projectId = params.id;
  const queryClient = useQueryClient();

  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const { data: templates = [], isLoading } = useQuery({
    queryKey: queryKeys.templates.forProject(projectId),
    queryFn: () => templatesApi.list(projectId),
  });

  const createMutation = useMutation({
    mutationFn: (input: CreateTemplateInput) => templatesApi.create(projectId, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.templates.forProject(projectId) });
      setCreating(false);
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, ...body }: { id: string } & Record<string, unknown>) =>
      templatesApi.update(projectId, id, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.templates.forProject(projectId) });
      setEditingId(null);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => templatesApi.delete(projectId, id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.templates.forProject(projectId) });
      setConfirmDelete(null);
    },
  });

  const cloneMutation = useMutation({
    mutationFn: (template: TemplateData) => {
      const schema = parseSchema(template.schema);
      if (!schema) throw new Error("Invalid template schema");
      return templatesApi.create(projectId, {
        name: `${template.name} (copy)`,
        platform: template.platform as CreateTemplateInput["platform"],
        templateType: template.templateType as CreateTemplateInput["templateType"],
        schema: { ...schema, name: `${schema.name} (copy)` },
        defaultValues: JSON.parse(template.defaultValues || "{}"),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.templates.forProject(projectId) });
    },
  });

  function handleCreate(schema: TemplateSchemaData, name: string) {
    createMutation.mutate({
      name,
      platform: schema.platform,
      templateType: schema.templateType,
      schema,
    });
  }

  function handleUpdate(id: string, schema: TemplateSchemaData, name: string) {
    updateMutation.mutate({
      id,
      name,
      schema,
      platform: schema.platform,
      templateType: schema.templateType,
    });
  }

  // Edit mode
  if (editingId) {
    const template = templates.find((t: TemplateData) => t.id === editingId);
    if (!template) return <div className="p-6 text-muted-foreground">Template not found</div>;
    const schema = parseSchema(template.schema);
    return (
      <div className="max-w-5xl mx-auto p-6 space-y-4">
        <PageHeader title={`Edit Template: ${template.name}`} />
        <TemplateForm
          initial={schema || undefined}
          onSave={(s, n) => handleUpdate(editingId, s, n)}
          onCancel={() => setEditingId(null)}
          saving={updateMutation.isPending}
        />
      </div>
    );
  }

  // Create mode
  if (creating) {
    return (
      <div className="max-w-5xl mx-auto p-6 space-y-4">
        <PageHeader title="Create Template" />
        <TemplateForm
          onSave={handleCreate}
          onCancel={() => setCreating(false)}
          saving={createMutation.isPending}
        />
      </div>
    );
  }

  // List mode
  return (
    <div className="max-w-4xl mx-auto p-6 space-y-6">
      <PageHeader
        title="Issue Templates"
        description="Configure issue body templates for AI-generated drafts"
        actions={<Button onClick={() => setCreating(true)}>+ New Template</Button>}
      />

      {isLoading && <div className="text-muted-foreground">Loading templates…</div>}

      {!isLoading && templates.length === 0 && (
        <Card className="p-8 text-center text-muted-foreground">
          No templates yet. Create your first template or seed defaults.
        </Card>
      )}

      <div className="space-y-3">
        {templates.map((template: TemplateData) => (
          <Card key={template.id} className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-foreground">{template.name}</span>
                  {template.isDefault && (
                    <span className="text-xs bg-info-muted text-info px-2 py-0.5 rounded">
                      Default
                    </span>
                  )}
                </div>
                <div className="text-xs text-muted-foreground mt-1 flex gap-3">
                  <span>Platform: {template.platform}</span>
                  <span>Type: {template.templateType}</span>
                  <span>
                    Sections:{" "}
                    {(() => {
                      const s = parseSchema(template.schema);
                      return s ? s.sections.length : "?";
                    })()}
                  </span>
                </div>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => setEditingId(template.id)}>
                  Edit
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => cloneMutation.mutate(template)}
                  disabled={cloneMutation.isPending}
                >
                  Clone
                </Button>
                {!template.isDefault && (
                  <>
                    {confirmDelete === template.id ? (
                      <div className="flex gap-1">
                        <Button
                          variant="outline"
                          size="sm"
                          className="text-destructive border-destructive/40"
                          onClick={() => deleteMutation.mutate(template.id)}
                        >
                          Confirm
                        </Button>
                        <Button variant="outline" size="sm" onClick={() => setConfirmDelete(null)}>
                          Cancel
                        </Button>
                      </div>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        className="text-destructive"
                        onClick={() => setConfirmDelete(template.id)}
                      >
                        Delete
                      </Button>
                    )}
                  </>
                )}
              </div>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
