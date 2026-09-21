/**
 * Epic #396 (MVP-4) — `tasks.md` row parser for `/speckit.taskstoissues`.
 *
 * Upstream Spec Kit `tasks.md` format (research §"Command-by-Command
 * Artifact Spec"): one row per atomic task. We accept the union of the
 * formats observed in upstream + METIS v1.2:
 *
 *   - Markdown table:
 *       | # | Title | Story Points | Dependencies | Notes |
 *       | --- | --- | --- | --- | --- |
 *       | T01 | Build login form | 3 | none | |
 *       | T02 | Wire auth API [P] | 5 | T01 | files: src/api/auth.ts |
 *
 *   - Bullet list (upstream form):
 *       - [ ] T01 — Build login form (depends-on: none) [P]  files: src/login.tsx
 *
 * Returned `Task` rows carry `{id, title, parallelizable, files[],
 * dependsOn[], userStorySlug?}`. The handler upserts GitHub issues by
 * `(featureSlug, taskId)`.
 */

export interface ParsedTask {
  id: string;
  title: string;
  parallelizable: boolean;
  files: string[];
  dependsOn: string[];
  userStorySlug: string | null;
  storyPoints: number | null;
  notes: string;
}

const ID_RE = /\bT\d{1,4}\b/i;
const PARALLEL_RE = /\[P\]/;
const FILE_RE = /(?:files?:\s*)([^|]+?)(?=$|\(|\[|\bdepends-on:|\bowner:)/i;
const DEPENDS_RE = /depends?-on:\s*([^)|]+)/i;
const STORY_PTS_RE = /^\s*(\d+)\s*$/;
const STORY_HEADER_RE = /^##+\s+(?:Story\s+)?(US\d+|user\s+story\s+\S+)\b/i;

export function parseTasksMarkdown(markdown: string): ParsedTask[] {
  const tasks: ParsedTask[] = [];
  const lines = markdown.split(/\r?\n/);
  let currentStory: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const storyMatch = STORY_HEADER_RE.exec(line);
    if (storyMatch) {
      currentStory = storyMatch[1]!.toLowerCase().replace(/\s+/g, "-");
      continue;
    }
    // Skip table separator rows like `| --- | --- |`.
    if (/^\s*\|[\s|:-]+\|\s*$/.test(line)) continue;
    if (line.trim().startsWith("|") && line.includes("|")) {
      const row = parseTableRow(line, currentStory);
      if (row) tasks.push(row);
      continue;
    }
    if (/^\s*-\s*(\[[ xX]\])?\s*T\d/.test(line)) {
      const row = parseBulletRow(line, currentStory);
      if (row) tasks.push(row);
    }
  }
  return tasks;
}

function parseTableRow(line: string, story: string | null): ParsedTask | null {
  const cells = line
    .split("|")
    .map((c) => c.trim())
    .filter(
      (_, i, arr) =>
        !(i === 0 && arr[0] === "") && !(i === arr.length - 1 && arr[arr.length - 1] === ""),
    );
  if (cells.length < 2) return null;
  const idCell = cells[0]!;
  if (!ID_RE.test(idCell)) return null;
  const id = ID_RE.exec(idCell)![0]!.toUpperCase();
  const titleRaw = cells[1] ?? "";
  const title = titleRaw.replace(PARALLEL_RE, "").trim();
  const parallelizable = PARALLEL_RE.test(titleRaw) || PARALLEL_RE.test(line);
  let storyPoints: number | null = null;
  let depCell = "";
  let notesCell = "";
  if (cells.length >= 3) {
    const sp = STORY_PTS_RE.exec(cells[2] ?? "");
    if (sp) storyPoints = Number.parseInt(sp[1]!, 10);
  }
  if (cells.length >= 4) depCell = cells[3] ?? "";
  if (cells.length >= 5) notesCell = cells[4] ?? "";
  const dependsOn = parseDeps(depCell);
  const files = parseFiles(notesCell);
  return {
    id,
    title,
    parallelizable,
    files,
    dependsOn,
    userStorySlug: story,
    storyPoints,
    notes: notesCell.trim(),
  };
}

function parseBulletRow(line: string, story: string | null): ParsedTask | null {
  const idMatch = ID_RE.exec(line);
  if (!idMatch) return null;
  const id = idMatch[0]!.toUpperCase();
  // Title: text after the id and before the first `(` / `[` / `files:` / `depends-on:`.
  const afterId = line.slice(line.indexOf(idMatch[0]) + idMatch[0].length);
  const titleEnd = earliestIndex(afterId, ["(", "[", "files:", "depends-on:"]);
  let titleRaw = (titleEnd === -1 ? afterId : afterId.slice(0, titleEnd))
    .replace(/^\s*[—-]\s*/, "")
    .trim();
  const parallelizable = PARALLEL_RE.test(line);
  titleRaw = titleRaw.replace(PARALLEL_RE, "").trim();
  return {
    id,
    title: titleRaw,
    parallelizable,
    files: parseFiles(line),
    dependsOn: parseDeps(line),
    userStorySlug: story,
    storyPoints: null,
    notes: "",
  };
}

function earliestIndex(haystack: string, needles: string[]): number {
  let earliest = -1;
  for (const n of needles) {
    const i = haystack.toLowerCase().indexOf(n.toLowerCase());
    if (i !== -1 && (earliest === -1 || i < earliest)) earliest = i;
  }
  return earliest;
}

function parseDeps(input: string): string[] {
  const m = DEPENDS_RE.exec(input);
  let raw: string;
  if (m) {
    raw = m[1]!.trim();
  } else if (/^[\sT0-9,]+$/i.test(input.trim()) && /T\d/i.test(input)) {
    // Raw column form (table cell): "T01" or "T01, T02, T03".
    raw = input.trim();
  } else {
    return [];
  }
  if (raw.toLowerCase() === "none" || raw.length === 0) return [];
  return raw
    .split(/[,\s]+/)
    .map((s) => s.trim().toUpperCase())
    .filter((s) => /^T\d+$/i.test(s));
}

function parseFiles(input: string): string[] {
  const m = FILE_RE.exec(input);
  if (!m) return [];
  return m[1]!
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && /[./]/.test(s));
}
