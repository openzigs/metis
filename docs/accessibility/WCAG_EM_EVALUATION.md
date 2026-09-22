# METIS — WCAG-EM Evaluation Report

**Website Accessibility Conformance Evaluation Methodology (WCAG-EM) 1.0**
Prepared per the W3C methodology at <https://www.w3.org/TR/WCAG-EM/>.

| Field | Value |
|-------|-------|
| **Product / version** | METIS — `0.1.0` (pre-stable alpha) |
| **Evaluated build** | `main` @ commit `52f818e` |
| **Report date** | 2026-07-04 |
| **Conformance target** | WCAG 2.2, Level AA |
| **Evaluation type** | **Internal FORMAL WCAG-EM self-evaluation** (in-house engineering team) |
| **Companion artifact** | [`VPAT.md`](./VPAT.md) — VPAT® 2.5 conformance report (results record) |
| **Evidence base** | [`SR_AUDIT.md`](./SR_AUDIT.md) + the merged automated a11y suites (see §5) |

> **Honesty statement.** This is an **in-house formal self-evaluation**, conducted
> by the METIS engineering team following the five WCAG-EM steps. It is **NOT a
> third-party audit and NOT an external certification**; no independent
> accessibility consultant reviewed it. Every *Supports* claim in the companion
> VPAT is traceable to a **merged** test or artifact cited in this report. An
> **independent third-party audit is recommended** before any external / customer
> / procurement conformance claim is made.

---

## Step 1 — Define the Scope of the Evaluation

Per [WCAG-EM §Step 1](https://www.w3.org/TR/WCAG-EM/#step1).

### 1.a Scope of the website

The **authenticated METIS web UI** (`ui/`, Next.js 14 App Router), served behind
sign-in. This covers the application shell (sidebar navigation, global header,
command palette) and the authenticated feature pages (dashboard, projects and
per-project workspaces, analysis, requirements/documentation, publishing, chat /
discussions, MCP, settings, admin). The public marketing surface, the raw REST
API (`server/`), and e-mail/other non-web channels are **out of scope**.

### 1.b Conformance target

**WCAG 2.2, Level AA.** All Level A and Level AA success criteria are evaluated;
Level AAA and the non-WCAG regulatory chapters (Section 508, EN 301 549) are out
of scope for this evaluation.

### 1.c Accessibility support baseline

Consistent with the existing methodology documented in the VPAT, the assistive
technology / user-agent baseline is:

- **Screen readers:** NVDA (Windows) and VoiceOver (macOS), on current Chromium
  and WebKit browsers.
- **Keyboard-only** operation (no pointing device).
- Current evergreen desktop browsers plus a 375px mobile viewport for the
  reflow / target-size checks.

By deliberate team decision (Epic #55, sub-issues #56 axe-core / #57 pa11y-ci /
#59 automated scan closed as *not adopted*), there is **no automated a11y rule
engine** (axe/pa11y/Lighthouse) in this repository. Conformance is assessed with a
**manual + assertion-based harness** — see §5.

### 1.d Additional evaluation requirements

- Both **light and dark** themes are in scope for colour/contrast criteria.
- Mobile reflow behaviour (<768px) and minimum target size are in scope.

### 1.e Build / version

METIS `0.1.0`, `main` @ `52f818e` (2026-07-04). This evaluation records the state
**after** Epic #658 (sub-issues #659–#663) merged.

---

## Step 2 — Explore the Target Website

Per [WCAG-EM §Step 2](https://www.w3.org/TR/WCAG-EM/#step2). The exploration reuses
the per-page audit in [`SR_AUDIT.md`](./SR_AUDIT.md) (Issue #58).

### Key pages and views (top-10 highest-traffic)

| # | Page | Route |
|---|------|-------|
| 1 | Dashboard | `/dashboard` |
| 2 | Projects | `/projects` |
| 3 | Project overview | `/projects/[id]/overview` |
| 4 | Analyze | `/projects/[id]/analysis` |
| 5 | Requirements (Documentation) | `/projects/[id]/documentation` |
| 6 | Publishing | `/projects/[id]/publish` |
| 7 | MCP | `/settings/mcp` |
| 8 | Settings | `/settings` |
| 9 | Admin | `/admin` |
| 10 | Chat / Discussions | `/chat` |

### Key user flows

- **Authentication** — sign-in form (username/password + federated SSO).
- **Analyze → Requirements → Publish** — the primary requirements-analysis flow.
- **Import / document ingest** — upload and URL ingest of source material.
- **Chat / discussion** — streamed AI responses and threaded discussion.

### Content types and functionality

Text content and forms, data tables (Documents, Repositories, Agent Runs, Admin
Usage, Publishing batches), streamed **live regions** (analysis progress, chat
transcript, publish log, doc-gen progress, import progress), and modal
dialogs/sheets.

### Common design patterns / components (shared shell)

Skip-to-content link, landmark regions (`banner`/`nav`/`main`/`complementary`),
the global header with **theme toggle + persistent Help menu**, the ⌘K command
palette (combobox/listbox), Radix dialogs/tooltips/tabs, the `ResponsiveTable`
reflow-to-cards primitive, and the shared `PausableLiveRegion` control.

---

## Step 3 — Select a Representative Sample

Per [WCAG-EM §Step 3](https://www.w3.org/TR/WCAG-EM/#step3).

### 3.a Structured sample (pages)

The **ten highest-traffic pages** listed in Step 2, chosen to cover the full range
of functionality, content types, and design patterns, plus the **shared shell**
that appears on every authenticated page (header, sidebar, skip link, command
palette).

### 3.b Sample of complete processes

The **Analyze → Requirements → Publish** flow and the **sign-in** flow are
included as complete processes.

### 3.c Components / patterns sampled

Global header **Help menu** (SC 3.2.6); credential and user-info **form inputs**
(SC 1.3.5); the design-token set for **borders / inputs / focus rings** in both
themes (SC 1.4.11); the sticky-header **focus/scroll** behaviour on scrollable
pages (SC 2.4.11); the auto-updating **live regions** across chat, discussion,
doc-gen, publish, and import (SC 2.2.2); and the **error-suggestion** helper across
user-facing forms (SC 3.3.3).

This is a self-selected representative sample, not an exhaustive per-screen sweep;
low-traffic screens were not each individually re-verified (see the VPAT Scope
caveat).

---

## Step 4 — Audit the Selected Sample

Per [WCAG-EM §Step 4](https://www.w3.org/TR/WCAG-EM/#step4). The full per-criterion
results record is **Table 1 (Level A)** and **Table 2 (Level AA)** of the companion
[`VPAT.md`](./VPAT.md). This section highlights the **six criteria closed by Epic
#658 (#659–#663)** and cites the specific merged evidence for each.

| SC | Level | Result | Merged evidence |
|----|:-----:|--------|-----------------|
| **2.2.2** Pause, Stop, Hide | A | Supports | Shared `PausableLiveRegion` pause/resume control (`ui/src/components/a11y/pausable-live-region.tsx`) applied to the chat transcript, discussion thread, doc-gen progress, publish log, and import progress; suspends `aria-live` while paused. Test: `ui/src/components/a11y/pausable-live-region.test.tsx`. Call sites: `chat/page.tsx`, `discussion-thread-view.tsx`, `documentation/page.tsx`, `publish/page.tsx`, `import/page.tsx` (#662). |
| **3.2.6** Consistent Help | A | Supports | Persistent `HelpMenu` (`ui/src/components/layout/help-menu.tsx`) rendered in a consistent relative location — right of the theme toggle — on every authenticated page (`ui/src/components/layout/header.tsx`). Tests: `header.test.tsx`, `help-menu.test.tsx`, and the shell assertion in `e2e/tests/ui-ia-accessibility.spec.ts` (#661). **Known limitation:** the menu's User-Guide / Report-an-issue links point at the private `github.com/openzigs/metis` repo and may 404 for non-org-member users — a follow-up, not a placement defect (SC 3.2.6 requires consistent *placement*, which is met). |
| **1.3.5** Identify Input Purpose | AA | Supports | HTML `autocomplete` purpose tokens on user-info inputs, e.g. `autocomplete="username"` / `autocomplete="current-password"` (`ui/src/components/auth/login-form.tsx`). Assertions: `ui/tests/login-form.test.tsx` (locks the tokens), plus `project-create-form.test.tsx`, `jira-page-autocomplete.test.tsx` (#659). |
| **1.4.11** Non-text Contrast | AA | Supports | `--border`, `--input`, and `--ring` boundary tokens asserted ≥3:1 against their adjacent surface in **both** themes by the `non-text contrast (SC 1.4.11)` block of `ui/tests/contrast-tokens.test.ts`; offending token values corrected in `ui/src/app/globals.css` (#660). |
| **2.4.11** Focus Not Obscured (Minimum) | AA | Supports | Global `scroll-padding-top: 4.5rem` (`ui/src/app/globals.css`) keeps focused controls clear of the `sticky top-0 h-16` header. Enforced by `keyboard focus is never fully obscured by the sticky header (#662)` in `e2e/tests/ui-ia-accessibility.spec.ts`, walking the tab order across six pages with `document.elementFromPoint` (#662). |
| **3.3.3** Error Suggestion | AA | Supports | Correction-suggestion sweep via the shared `ui/src/lib/error-suggestion.ts` helper across user-facing forms (project create, URL/document ingest, budget, workspace admin, connections, add-documents) (#663). |

All other A/AA criteria retain the ratings recorded in the VPAT (unchanged by this
epic). No criterion is rated *Does Not Support*.

---

## Step 5 — Report the Evaluation Findings

Per [WCAG-EM §Step 5](https://www.w3.org/TR/WCAG-EM/#step5).

### 5.a Results record

The authoritative per-criterion results record is the companion
[`VPAT.md`](./VPAT.md). Post-epic conformance summary (independently re-derived by
counting the VPAT rows):

| Level | Supports | Partially Supports | Does Not Support | Not Applicable | Total |
|-------|:--------:|:------------------:|:----------------:|:--------------:|:-----:|
| **A**  | 26 | 0 | 0 | 6 | 32 |
| **AA** | 21 | 0 | 0 | 3 | 24 |

Note on levels: **SC 3.2.6 Consistent Help is a Level A criterion** in WCAG 2.2,
so its N/A→Supports move increases the Level A *Supports* count and decreases the
Level A *Not Applicable* count (7→6); it does **not** affect the Level AA tallies.

### 5.b Conformance statement

On the evaluated scope and sample, METIS **meets WCAG 2.2 Level A and Level AA**,
with **no remaining Partially-Supports criterion**. This is an **in-house formal
WCAG-EM self-evaluation**, not a third-party conformance claim.

### 5.c Evidence package

- [`SR_AUDIT.md`](./SR_AUDIT.md) — manual NVDA/VoiceOver per-page findings/fixes
  matrix (Issue #58) and the per-page regression-test index.
- [`VPAT.md`](./VPAT.md) — VPAT® 2.5 conformance report (full results record).
- Automated / assertion-based suites (run on every PR via the `ui` job unless
  noted):
  - `ui/src/components/a11y/pausable-live-region.test.tsx` — SC 2.2.2.
  - `ui/src/components/layout/header.test.tsx`, `help-menu.test.tsx` — SC 3.2.6.
  - `ui/tests/login-form.test.tsx` (+ form autocomplete suites) — SC 1.3.5.
  - `ui/tests/contrast-tokens.test.ts` — SC 1.4.3 and SC 1.4.11.
  - `ui/src/lib/error-suggestion.ts` + form tests — SC 3.3.3.
  - `e2e/tests/ui-ia-accessibility.spec.ts` — SC 2.4.11 (focus-not-obscured),
    role/name, landmarks, target size, mobile reflow. *(The full `e2e` job runs
    on every pull request as of #62.)*

### 5.d Limitations and recommendation

- The sample is the top-10 pages + shared shell; low-traffic screens were not each
  exhaustively re-verified.
- Contrast checks are **token-level** (computed ratios of design tokens), not a
  rendered-pixel scan of every composed surface.
- The `HelpMenu` link targets are a known follow-up (see SC 3.2.6 above).
- **Recommendation:** commission an **independent third-party accessibility audit**
  before making any external, customer-facing, or procurement conformance claim.
  This in-house evaluation is intended as audit-readiness evidence, not a
  substitute for that independent review.
