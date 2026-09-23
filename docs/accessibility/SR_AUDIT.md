# Screen-Reader Audit — Top-10 Pages (Issue #58 / Epic #55)

Manual screen-reader (NVDA + VoiceOver) audit of the ten highest-traffic
surfaces, with the concrete violations found and the fix applied to each. This
audit extends the team's chosen **manual Playwright + vitest** a11y harness
(`e2e/tests/ui-ia-accessibility.spec.ts`, `ui/tests/contrast-tokens.test.ts`,
and the per-page `ui/tests/*.test.tsx` component tests) — Epic #55 deliberately
did **not** adopt axe-core (#56) or pa11y-ci (#57), so no automated rule engine
is used here; every row below was verified by role/name/landmark assertions.

## Shared shell (applies to every page)

The authenticated shell (`ui/src/components/layout/app-shell.tsx`) already
provides the page-level landmarks, so per-page work below is scoped to the
*content* of `<main>`:

- `role="main"` on `#main-content`, `role="banner"` on the header, a labelled
  sidebar `nav`, and a visible-on-focus **"Skip to main content"** link.
- The auth/loading gate is a `role="status" aria-live="polite"` region.
- Toasts render through the app Toaster (an `aria-live` region), so
  mutation success/failure is announced globally.

These are locked in by `ui/tests/app-shell.test.tsx` and are **not** re-audited
per page.

## Per-page matrix

Legend: **OK** = already conformant (test added to lock it in); **FIXED** =
violation found and corrected in this issue.

| # | Page | Route | Checks performed | Findings & fixes |
|---|------|-------|------------------|------------------|
| 1 | Dashboard | `/dashboard` | h1, widgets region, per-widget heading, async live regions | **OK.** Single `h1`; widgets grid is a labelled `region` ("Dashboard widgets"); each widget has an `h2`; loading/empty states are `role="status"`. |
| 2 | Projects | `/projects` | h1, per-card heading, icon-only control names, load-error announcement | **FIXED.** The load-failure message was silent red text — added `role="alert"` so SR users hear "Failed to load projects." (Per-card `h2`, "Project actions" overflow button name, and "New project" dialog title were already correct.) |
| 3 | Project overview | `/projects/[id]/overview` | h1, empty-state heading, regenerate error/loading announcement | **FIXED.** The inline regenerate-failure card was a silent `<Card>` — added `role="alert"`; the "Loading overview…" text is now `role="status"`. (The success/failure toasts were already wired, #423.) |
| 4 | Analyze | `/projects/[id]/analysis` | heading hierarchy (h1→h2→h3→h4), agent-checkbox names, per-requirement control names, start-error announcement | **FIXED.** The "Run analysis" start-error `<p>` was silent — added `role="alert"`. Heading hierarchy, `<label>`-wrapped agent checkboxes, and the `aria-label`'d "Comments for …" / `aria-expanded` History controls were already correct. |
| 5 | Requirements (Documentation) | `/projects/[id]/documentation` | Generate-form control labels, tab roles, degraded-doc banner | **FIXED.** The Generate-form Scope / Repository / Database / Document-Type / Title controls used bare `<label>`s with **no** `htmlFor`/`id` association (announced as unlabelled comboboxes) — associated each label with its control. (The degraded-output banner was already `role="alert"`; the Document/Schema-Graph switcher was already a named tablist.) |
| 6 | Publishing | `/projects/[id]/publish` | h1, draft-checkbox names, batches-table headers, live progress log | **FIXED.** (a) Draft-selection checkboxes were unlabelled — added `aria-label="Select draft: {title}"`. (b) The batches `<table>` headers lacked `scope="col"` and had an empty action `<th>` — scoped all headers and gave the actions column an `sr-only` name. (c) The live publish log `<ol>` now has `aria-live="polite"` + a name so streamed events are announced. Also fixed a latent temporal-dead-zone crash (`selectedDrafts` was read before its `useState` declaration) that prevented the draft list — and therefore the checkbox labels — from ever rendering. |
| 7 | MCP | `/settings/mcp` | tablist semantics, tab/tabpanel wiring, form-control labels | **FIXED.** The section switcher was `<nav role="tablist">` (a `navigation`/`tablist` role conflict) with **no** accessible name and no panel wiring. Converted to a named `role="tablist"` (`aria-label="MCP platform sections"`), gave each tab an `id`/`aria-controls`, and wrapped the active content in a `role="tabpanel"` labelled by its tab. |
| 8 | Settings | `/settings` | h1, per-card heading, decorative-icon hiding | **OK.** Single `h1`; every hub card has an `h2`; category icons are `aria-hidden`. |
| 9 | Admin | `/admin` | single h1, no skipped heading levels, named links | **OK.** Exactly one `h1` (via `PlaceholderPage`'s `aria-labelledby`), a level-2 "Sections" heading, and every admin sub-surface is a named link. |
| 10 | Chat | `/chat` | h1, live transcript, input name, complementary region, error announcement | **OK.** Transcript is `role="log" aria-live="polite"`; message input has `aria-label="Message"`; skills sidebar is a labelled `complementary`; stream errors are `role="alert"`. |

## Automated regression tests (each page has ≥1 SR test)

Per-page SR assertions were added to the vitest suite (runs on every PR via the
`ui` job) using role/accessible-name/landmark queries:

| Page | Test file |
|------|-----------|
| Dashboard | `ui/tests/dashboard-page.test.tsx` |
| Projects | `ui/tests/projects-page-a11y.test.tsx` (new) |
| Project overview | `ui/tests/overview-page.test.tsx` |
| Analyze | `ui/tests/analysis/analysis-collab.test.tsx` |
| Requirements (Documentation) | `ui/tests/documentation-page-scopes.test.tsx` |
| Publishing | `ui/tests/publish-page-analysis-picker.test.tsx` |
| MCP | `ui/tests/mcp-settings-page.test.tsx` |
| Settings | `ui/tests/settings-page.test.tsx` |
| Admin | `ui/tests/admin-page-a11y.test.tsx` (new) |
| Chat | `ui/tests/chat-page-ux.test.tsx` |

The Playwright a11y harness (`e2e/tests/ui-ia-accessibility.spec.ts`) also gains
a per-route landmark/heading audit for the authenticated integration path. Note
the full `e2e` job runs on every pull request (#62); the vitest tests above are
the enforced regression bar on each PR.
