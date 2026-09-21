/**
 * Phase 12 — Library Templates section (issue #85).
 *
 * CRUD for prompt templates with `{{var}}` substitution. Required vs
 * optional vars are declared per template (variable name list); the Run
 * button refuses to launch if a required variable is blank, blocking the
 * user from sending a half-filled prompt to the model.
 *
 * Storage is per-browser localStorage — the AC scopes templates to the
 * analyst's working surface, not a shared catalogue.
 */
"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  extractVariables,
  stashRunPayload,
  substitute,
  templatesStore,
  type PromptTemplate,
} from "@/lib/templates";

export function TemplatesSection() {
  const [templates, setTemplates] = useState<PromptTemplate[]>([]);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<PromptTemplate | null>(null);
  const [running, setRunning] = useState<PromptTemplate | null>(null);

  function refresh() {
    setTemplates(templatesStore.list());
  }

  useEffect(() => {
    refresh();
  }, []);

  function handleSave(input: {
    id?: string;
    name: string;
    description: string;
    body: string;
    required: string[];
  }) {
    if (input.id) {
      templatesStore.update(input.id, {
        name: input.name,
        description: input.description,
        body: input.body,
        required: input.required,
      });
    } else {
      templatesStore.create({
        name: input.name,
        description: input.description,
        body: input.body,
        required: input.required,
      });
    }
    refresh();
    setEditorOpen(false);
    setEditing(null);
  }

  function handleDelete(id: string) {
    templatesStore.remove(id);
    refresh();
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Reusable prompts. Use <code>{"{{var}}"}</code> to define a variable; mark which are
          required when saving.
        </p>
        <Button
          onClick={() => {
            setEditing(null);
            setEditorOpen(true);
          }}
          data-testid="templates-new"
        >
          New template
        </Button>
      </div>

      {templates.length === 0 ? (
        <Card
          className="border-dashed p-6 text-sm text-muted-foreground"
          data-testid="templates-empty"
        >
          <p className="font-medium text-foreground">No templates yet</p>
          <p>Create your first reusable prompt above.</p>
        </Card>
      ) : (
        <ul className="grid gap-3" data-testid="templates-list">
          {templates.map((t) => (
            <li key={t.id}>
              <Card className="p-4" data-testid={`template-card-${t.id}`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="space-y-1">
                    <h3 className="font-medium">{t.name}</h3>
                    {t.description ? (
                      <p className="text-sm text-muted-foreground">{t.description}</p>
                    ) : null}
                    <pre className="overflow-x-auto rounded bg-muted p-2 text-xs">{t.body}</pre>
                    <p className="text-xs text-muted-foreground">
                      Variables:{" "}
                      {extractVariables(t.body).length === 0 ? (
                        <em>none</em>
                      ) : (
                        extractVariables(t.body).map((v) => (
                          <code
                            key={v}
                            className={
                              t.required.includes(v)
                                ? "mr-1 rounded bg-rose-100 px-1 text-rose-900"
                                : "mr-1 rounded bg-muted px-1"
                            }
                          >
                            {v}
                            {t.required.includes(v) ? "*" : ""}
                          </code>
                        ))
                      )}
                    </p>
                  </div>
                  <div className="flex flex-col gap-1">
                    <Button
                      size="sm"
                      onClick={() => setRunning(t)}
                      data-testid={`template-run-${t.id}`}
                    >
                      Run
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setEditing(t);
                        setEditorOpen(true);
                      }}
                      data-testid={`template-edit-${t.id}`}
                    >
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleDelete(t.id)}
                      data-testid={`template-delete-${t.id}`}
                    >
                      Delete
                    </Button>
                  </div>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}

      {editorOpen ? (
        <TemplateEditor
          template={editing}
          onSave={handleSave}
          onCancel={() => {
            setEditorOpen(false);
            setEditing(null);
          }}
        />
      ) : null}

      {running ? <RunDialog template={running} onClose={() => setRunning(null)} /> : null}
    </div>
  );
}

interface EditorProps {
  template: PromptTemplate | null;
  onSave: (input: {
    id?: string;
    name: string;
    description: string;
    body: string;
    required: string[];
  }) => void;
  onCancel: () => void;
}

function TemplateEditor({ template, onSave, onCancel }: EditorProps) {
  const [name, setName] = useState(template?.name ?? "");
  const [description, setDescription] = useState(template?.description ?? "");
  const [body, setBody] = useState(template?.body ?? "");
  const [requiredCsv, setRequiredCsv] = useState((template?.required ?? []).join(", "));
  const detected = useMemo(() => extractVariables(body), [body]);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim() || !body.trim()) return;
    const required = requiredCsv
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .filter((s) => detected.includes(s));
    onSave({
      ...(template?.id ? { id: template.id } : {}),
      name: name.trim(),
      description: description.trim(),
      body,
      required,
    });
  }

  return (
    <Card className="space-y-3 p-4" data-testid="template-editor">
      <h3 className="text-sm font-semibold">{template ? "Edit template" : "New template"}</h3>
      <form className="space-y-3" onSubmit={handleSubmit}>
        <label className="block space-y-1 text-sm">
          <span className="text-muted-foreground">Name</span>
          <Input
            data-testid="template-editor-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </label>
        <label className="block space-y-1 text-sm">
          <span className="text-muted-foreground">Description</span>
          <Input
            data-testid="template-editor-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        <label className="block space-y-1 text-sm">
          <span className="text-muted-foreground">Body</span>
          <textarea
            data-testid="template-editor-body"
            className="w-full rounded border bg-background p-2 font-mono text-sm"
            rows={6}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            required
          />
          <p className="text-xs text-muted-foreground">
            Detected variables:{" "}
            {detected.length === 0 ? <em>none</em> : detected.map((v) => `{{${v}}}`).join(" ")}
          </p>
        </label>
        <label className="block space-y-1 text-sm">
          <span className="text-muted-foreground">Required vars (comma-separated)</span>
          <Input
            data-testid="template-editor-required"
            placeholder="customer, ticket_id"
            value={requiredCsv}
            onChange={(e) => setRequiredCsv(e.target.value)}
          />
        </label>
        <div className="flex gap-2">
          <Button type="submit" data-testid="template-editor-save">
            Save
          </Button>
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}

function RunDialog({ template, onClose }: { template: PromptTemplate; onClose: () => void }) {
  const router = useRouter();
  const variables = useMemo(() => extractVariables(template.body), [template.body]);
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(variables.map((v) => [v, ""])),
  );
  const [error, setError] = useState<string | null>(null);

  function handleRun(e: FormEvent) {
    e.preventDefault();
    try {
      const prompt = substitute(template.body, values, template.required);
      stashRunPayload({ prompt, templateId: template.id, templateName: template.name });
      router.push("/workbench");
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <Card className="space-y-3 p-4" data-testid="template-run-dialog">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Run: {template.name}</h3>
        <Button size="sm" variant="outline" onClick={onClose}>
          Close
        </Button>
      </div>
      <form className="space-y-2" onSubmit={handleRun}>
        {variables.length === 0 ? (
          <p className="text-xs text-muted-foreground">No variables to fill.</p>
        ) : (
          variables.map((v) => (
            <label key={v} className="block space-y-1 text-sm">
              <span className="text-muted-foreground">
                {v}
                {template.required.includes(v) ? <span className="text-rose-500"> *</span> : null}
              </span>
              <Input
                data-testid={`template-run-var-${v}`}
                value={values[v] ?? ""}
                onChange={(e) => setValues({ ...values, [v]: e.target.value })}
              />
            </label>
          ))
        )}
        {error ? (
          <p
            role="alert"
            data-testid="template-run-error"
            className="rounded border border-destructive p-2 text-xs text-destructive"
          >
            {error}
          </p>
        ) : null}
        <Button type="submit" data-testid="template-run-submit">
          Open in workbench
        </Button>
      </form>
    </Card>
  );
}
