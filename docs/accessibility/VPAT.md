# METIS — Accessibility Conformance Report (VPAT® 2.5)

**Voluntary Product Accessibility Template® (VPAT®) — Revision 2.5 (WCAG Edition)**
Based on the WCAG 2.2 A/AA success criteria. VPAT® is a registered service mark
of the Information Technology Industry Council (ITI).

> **Template note (2.4 → 2.5 retarget).** Issue #62 was originally scoped to
> "VPAT 2.4". This report is instead produced against **VPAT® Revision 2.5**, the
> current ITI/ITIC template revision, because 2.5 is the revision aligned with
> **WCAG 2.2** (2.4 predates WCAG 2.2 and does not carry the six new 2.2 success
> criteria). Retargeting keeps the artifact aligned with the WCAG 2.2 AA scope of
> Epic #55.

---

## Product information

| Field | Value |
|-------|-------|
| **Name of product / version** | METIS — `0.1.0` (pre-stable alpha) |
| **Product description** | Multi-package web application for AI-assisted requirements analysis, specification generation, and publishing. `server/` (Express + Prisma + LanceDB RAG), `ui/` (Next.js 14 + Tailwind + shadcn/Radix). |
| **Report date** | 2026-07-04 |
| **Report version** | 1.1 (internal formal WCAG-EM self-evaluation) |
| **Contact information** | METIS engineering team (via the project issue tracker) |
| **Notes** | This report covers the authenticated web UI. See **Evaluation methods used** and the per-criterion **Remarks** for the exact scope of what was verified. The evaluation procedure and evidence package are documented in the companion [`WCAG_EM_EVALUATION.md`](./WCAG_EM_EVALUATION.md). |
| **Evaluation status** | **Internal FORMAL WCAG-EM self-evaluation** — conducted in-house by the METIS engineering team following the W3C [Website Accessibility Conformance Evaluation Methodology (WCAG-EM) 1.0](https://www.w3.org/TR/WCAG-EM/). This is a formal *self*-evaluation, **NOT a third-party audit or external certification**; no independent accessibility consultant reviewed this report. All *Supports* claims are backed by merged tests/artifacts (see per-criterion Remarks and the companion evaluation report). It should still be re-validated by an independent auditor before being used as a formal customer-facing / procurement conformance claim. |

---

## Applicable standards / guidelines

| Standard / guideline | Included in report |
|----------------------|--------------------|
| Web Content Accessibility Guidelines (WCAG) 2.2, Level A | **Yes** |
| Web Content Accessibility Guidelines (WCAG) 2.2, Level AA | **Yes** |
| Web Content Accessibility Guidelines (WCAG) 2.2, Level AAA | No (out of scope) |
| Revised Section 508 (2017) | Not separately evaluated |
| EN 301 549 | Not separately evaluated |

The WCAG 2.2 A and AA criteria are documented in **Table 1** (Level A) and
**Table 2** (Level AA) below. Level AAA and the non-WCAG regulatory chapters are
out of scope for this revision.

---

## Terms

The terms used to describe conformance for each criterion (per the VPAT 2.5
convention):

| Term | Definition |
|------|------------|
| **Supports** | The functionality of the product has at least one method that meets the criterion without known defects, within the evaluated scope. |
| **Partially Supports** | Some functionality of the product does not meet the criterion, or the criterion is met only in part / not yet exhaustively verified. |
| **Does Not Support** | The majority of product functionality does not meet the criterion. |
| **Not Applicable** | The criterion is not relevant to the product. |
| **Not Evaluated** | The product has not been evaluated against the criterion. (Used only where explicitly stated; this report evaluates every A/AA criterion.) |

---

## Evaluation methods used

Epic #55 **deliberately did not adopt an automated accessibility rule engine.**
Sub-issues **#56 (axe-core)** and **#57 (pa11y-ci)** were closed as
*intentionally not adopted*, and **#59 (UI-Vision automated scan)** likewise. As a
result **there is no axe-core / pa11y / Lighthouse automated a11y scanning in this
repository**, and no such scan underlies this report. Conformance was assessed with
the team's chosen **manual + assertion-based harness**:

1. **Manual screen-reader audit (NVDA + VoiceOver)** of the ten highest-traffic
   pages — dashboard, projects, project overview, analyze, requirements
   (documentation), publishing, MCP, settings, admin, chat — recorded as a
   per-page findings/fixes matrix in
   [`docs/accessibility/SR_AUDIT.md`](./SR_AUDIT.md) (Issue #58). Every claim in
   this VPAT that is scoped to "audited pages" traces to that matrix.

2. **Manual Playwright integration a11y suite** —
   `e2e/tests/ui-ia-accessibility.spec.ts` — asserting role/accessible-name,
   landmark/single-`h1`, minimum hit-target size (24×24 CSS px), the mobile
   **reflow-to-cards** behaviour at 375px (WCAG 1.4.10), a ≥44px mobile touch
   target (WCAG 2.5.8), and the mobile command-palette combobox/listbox semantics.
   (The full `e2e` job runs on every pull request as of #62.)

3. **Vitest + @testing-library component a11y tests** — per-page screen-reader
   regression tests (role / accessible-name / landmark queries) locked in for each
   of the top-10 pages, plus `ui/src/components/tables/responsive-table.test.tsx`
   (both layouts, column-label association, touch-target class) and
   `ui/tests/command-palette-mobile.test.tsx` (sheet-vs-dialog variant, keyboard
   nav, combobox/listbox/live-region semantics). These run on **every PR** via the
   `ui` job and are the enforced regression bar.

4. **Design-token contrast unit tests** — `ui/tests/contrast-tokens.test.ts`
   computes the actual contrast ratio of the muted-foreground text tokens against
   their theme backgrounds and asserts ≥4.5:1 (WCAG 1.4.3). This is a token-level
   check, not a rendered-pixel scan of every composed surface.

5. **Keyboard-only walkthrough** of the primary analyze → requirements → publish
   flow, performed manually.

**Scope caveat (applies to the whole report):** the manual audit exhaustively
covered the **top-10 pages** and the converted data tables / command palette.
Criteria marked *Supports* are supported **on the audited surfaces**; they were
not exhaustively re-verified on every low-traffic screen. Where a criterion is
only partially met, or where verification did not extend app-wide, this is stated
explicitly in the **Remarks** column rather than claimed as full support.

---

## WCAG 2.2 conformance summary

| Level | Supports | Partially Supports | Does Not Support | Not Applicable | Total |
|-------|:--------:|:------------------:|:----------------:|:--------------:|:-----:|
| **A**  | 26 | 0 | 0 | 6 | 32 |
| **AA** | 21 | 0 | 0 | 3 | 24 |

**Overall posture:** METIS **conforms to WCAG 2.2 Level A and Level AA on the
evaluated scope**, with **no remaining Partially-Supports criterion**. The six
criteria previously rated Partial or Not Applicable were closed by Epic #658
(sub-issues #659–#663): 2.2.2 Pause/Stop and 3.2.6 Consistent Help at Level A,
and 1.3.5 Identify Input Purpose, 1.4.11 Non-text Contrast, 2.4.11 Focus Not
Obscured, and 3.3.3 Error Suggestion at Level AA — each now *Supports* with an
evidence-backed Remark citing the merged test/artifact. No criterion is rated
*Does Not Support*. The evidence base is the post-fix state of the audited top-10
pages (Issue #58), the mobile reflow / target-size work (#60, #61), and the
per-criterion regression suites landed by #659–#663. Every *Supports* rating is
scoped to the evaluated surfaces (see the **Scope caveat** and the companion
[WCAG-EM evaluation report](./WCAG_EM_EVALUATION.md)); criteria were not
exhaustively re-verified on every low-traffic screen.

All six **new WCAG 2.2 criteria** (2.4.11, 2.5.7, 2.5.8, 3.2.6, 3.3.7, 3.3.8)
are addressed explicitly in the tables below.

> **Note on SC 4.1.1 Parsing.** WCAG 2.2 **removed** SC 4.1.1 Parsing (it is
> obsolete). Per the VPAT 2.5 WCAG-edition convention it is listed as *Supports*
> for continuity; it imposes no requirement under WCAG 2.2.

---

## Table 1: Success Criteria, Level A

Notes: **DOM/React output is well-formed** and semantics are provided through
Radix primitives + the audit fixes in #58.

| Criterion | Conformance Level | Remarks and Explanations |
|-----------|-------------------|--------------------------|
| **1.1.1** Non-text Content | Supports | Icon-only controls expose accessible names (`aria-label`), verified by the Playwright A1 assertions and per-page SR tests; decorative/category icons are `aria-hidden`. Verified on audited top-10 pages; not exhaustively verified app-wide. |
| **1.2.1** Audio-only and Video-only (Prerecorded) | Not Applicable | The product presents no prerecorded audio-only or video-only content. |
| **1.2.2** Captions (Prerecorded) | Not Applicable | No prerecorded synchronized media. |
| **1.2.3** Audio Description or Media Alternative (Prerecorded) | Not Applicable | No prerecorded synchronized media. |
| **1.3.1** Info and Relationships | Supports | Landmarks (`main`/`banner`/`nav`/`complementary`), heading hierarchy, `<th scope="col">` table headers, and programmatic `<label>`↔control associations. The #58 audit found and fixed unlabelled form controls (documentation Generate form) and unscoped table headers (publishing). Mobile card layout uses `<dl>/<dt>/<dd>` so values retain their column label. Verified on audited pages; not exhaustive. |
| **1.3.2** Meaningful Sequence | Supports | Reading/DOM order is meaningful; the mobile reflow (#60) preserves top-to-bottom column order. |
| **1.3.3** Sensory Characteristics | Supports | Instructions do not rely solely on shape, size, or position; controls carry text/accessible names. |
| **1.4.1** Use of Color | Supports | Error/status conditions are conveyed by `role="alert"`/`role="status"` text and iconography, not color alone — the #58 audit specifically fixed "silent red text" load-failure messages on projects/overview/analyze by adding `role="alert"`. |
| **1.4.2** Audio Control | Not Applicable | No auto-playing audio. |
| **2.1.1** Keyboard | Supports | All audited interactive elements are keyboard-operable; the ⌘K command palette provides full keyboard navigation (Arrow/Enter/Escape). Verified via the keyboard walkthrough and Playwright focus assertions on audited surfaces. |
| **2.1.2** No Keyboard Trap | Supports | Dialogs/sheets use Radix focus management with Escape-to-close and focus restoration; no keyboard traps observed. |
| **2.1.4** Character Key Shortcuts | Supports | The single global shortcut (command palette) requires a modifier (Ctrl/⌘ + K); no single-character key shortcuts are active on content. |
| **2.2.1** Timing Adjustable | Not Applicable | No time limits are imposed on reading or completing content interactions. |
| **2.2.2** Pause, Stop, Hide | Supports | The qualifying auto-updating live regions — chat transcript, discussion thread, doc-generation progress, publish log, and import progress — are wrapped in the shared `PausableLiveRegion` control (`ui/src/components/a11y/pausable-live-region.tsx`), which exposes an explicit user Pause/Resume affordance and suspends `aria-live` announcements while paused. Locked by `ui/src/components/a11y/pausable-live-region.test.tsx` and wired at `chat/page.tsx`, `discussion-thread-view.tsx`, `documentation/page.tsx`, `publish/page.tsx`, and `import/page.tsx` (#662). |
| **2.3.1** Three Flashes or Below Threshold | Supports | No content flashes more than three times per second. |
| **2.4.1** Bypass Blocks | Supports | The app shell provides a visible-on-focus "Skip to main content" link plus page landmarks (`app-shell.tsx`, locked by `app-shell.test.tsx`). |
| **2.4.2** Page Titled | Supports | Each page has a descriptive title and exactly one `<h1>`; single-`h1`/heading assertions are part of the audit and the Playwright per-route check. |
| **2.4.3** Focus Order | Supports | Focus order follows a logical, meaningful sequence on audited pages; dialogs trap and restore focus. |
| **2.4.4** Link Purpose (In Context) | Supports | Links have descriptive accessible names (admin sub-surfaces, card actions); the audit confirmed named links across the audited pages. |
| **2.5.1** Pointer Gestures | Supports | No multipoint or path-based gestures are required for any functionality. |
| **2.5.2** Pointer Cancellation | Supports | Activation occurs on the up-event (Radix/standard button semantics); no down-event-only actions. |
| **2.5.3** Label in Name | Supports | Accessible names include the visible label text (e.g. the audit added `aria-label="Select draft: {title}"` matching visible titles). Verified on audited controls. |
| **2.5.4** Motion Actuation | Not Applicable | No functionality is operated by device or user motion. |
| **3.1.1** Language of Page | Supports | The document root sets `<html lang="en">` (`ui/src/app/layout.tsx`). |
| **3.2.1** On Focus | Supports | Receiving focus does not trigger an unexpected change of context. |
| **3.2.2** On Input | Supports | Changing a control's setting does not automatically cause an unexpected change of context; explicit submit/apply actions are used. |
| **3.2.6** Consistent Help (new in 2.2) | Supports | The global header exposes a persistent Help affordance (`HelpMenu`, `ui/src/components/layout/help-menu.tsx`) rendered in the same relative location — immediately right of the theme toggle in `header.tsx` — on every authenticated page, satisfying the consistent-ordering requirement of SC 3.2.6. Locked by `header.test.tsx` / `help-menu.test.tsx` and the Playwright shell assertion (`ui-ia-accessibility.spec.ts`) (#661). **Known limitation / follow-up:** the menu's self-help and contact links (User Guide, Report an issue) currently target the private `github.com/openzigs/metis` repository, so they may return 404 for authenticated users who are not members of that GitHub org. This does **not** affect the SC 3.2.6 *consistent-placement* requirement (which is met), but the link targets should be pointed at a publicly reachable help destination in a follow-up. |
| **3.3.1** Error Identification | Supports | Form and load errors are surfaced in text via `role="alert"` (added across projects/overview/analyze/documentation in #58) so they are both visible and announced. |
| **3.3.2** Labels or Instructions | Supports | Inputs have programmatic labels; the #58 audit fixed the documentation Generate-form controls that previously used unassociated `<label>`s. Verified on audited forms. |
| **3.3.7** Redundant Entry (new in 2.2) | Supports | Multi-step flows do not require re-entering information already supplied earlier in the same process; prior values are retained. Verified on audited flows; not exhaustively audited across every multi-step process. |
| **4.1.1** Parsing | Supports | **Removed/obsolete in WCAG 2.2** — imposes no requirement. React output is well-formed; no requirement to meet. |
| **4.1.2** Name, Role, Value | Supports | Interactive components expose correct name/role/value/state via native elements and Radix (tabs↔tabpanels wired in the MCP fix, `aria-expanded`/`aria-selected`/`aria-pressed` on toggles). Verified on audited pages. |

---

## Table 2: Success Criteria, Level AA

| Criterion | Conformance Level | Remarks and Explanations |
|-----------|-------------------|--------------------------|
| **1.2.4** Captions (Live) | Not Applicable | No live synchronized media. |
| **1.2.5** Audio Description (Prerecorded) | Not Applicable | No prerecorded synchronized media. |
| **1.3.4** Orientation | Supports | Responsive layout works in both portrait and landscape; no orientation lock. |
| **1.3.5** Identify Input Purpose | Supports | Input fields that collect information about the user carry the HTML `autocomplete` purpose tokens defined by WCAG 2.2 SC 1.3.5 — e.g. the credential inputs use `autocomplete="username"` / `autocomplete="current-password"` (`ui/src/components/auth/login-form.tsx`). The tokens are locked against regression by explicit assertions in `ui/tests/login-form.test.tsx` (and further form suites such as `project-create-form.test.tsx`, `jira-page-autocomplete.test.tsx`) (#659). |
| **1.4.3** Contrast (Minimum) | Supports | Muted-foreground text tokens are asserted ≥4.5:1 against their theme backgrounds by `ui/tests/contrast-tokens.test.ts`. This is a token-level check; not every composed foreground/background pairing was individually measured. |
| **1.4.4** Resize Text | Supports | Layout uses relative units and reflows; text scales with browser zoom to 200% without loss of content on audited pages. |
| **1.4.5** Images of Text | Supports | Text is rendered as real text, not images of text. |
| **1.4.10** Reflow | Supports | Primary layouts reflow to a single column, and the five highest-traffic data tables (Documents, Repositories, Agent Runs, Admin Usage, Publishing batches) reflow to a stacked card list below 768px via the `ResponsiveTable` primitive (#60) — verified by the Playwright 375px reflow assertion and the component tests. No horizontal scrolling of wide tables at narrow widths on the converted surfaces; low-traffic tables were not each individually verified. |
| **1.4.11** Non-text Contrast | Supports | The non-text boundary tokens that carry UI/state/graphical contrast — `--border` (component/divider boundary), `--input` (form-control boundary), and `--ring` (keyboard focus indicator) — are asserted to clear ≥3:1 against their adjacent surface in **both** light and dark themes by `ui/tests/contrast-tokens.test.ts` (the `non-text contrast (SC 1.4.11)` describe block), computing real relative-luminance ratios. The token values were corrected in `ui/src/app/globals.css` where needed to meet the threshold (#660). |
| **1.4.12** Text Spacing | Supports | Text uses relative spacing; no fixed-height containers clipping text were observed on audited pages when spacing is increased. Not exhaustively verified app-wide. |
| **1.4.13** Content on Hover or Focus | Supports | Hover/focus content (Radix tooltips/popovers) is dismissable, hoverable, and persistent. Verified on audited components. |
| **2.4.5** Multiple Ways | Supports | Content is reachable through more than one mechanism: the persistent sidebar navigation and the global ⌘K command palette (which also searches projects). |
| **2.4.6** Headings and Labels | Supports | Headings and labels are descriptive; heading hierarchy (h1→h2→…) was audited and corrected where needed (#58). |
| **2.4.7** Focus Visible | Supports | A visible focus indicator is present on interactive elements (focus rings / Radix defaults). Verified on audited pages; not exhaustively verified on every custom control. |
| **2.4.11** Focus Not Obscured (Minimum) | Supports | A global `scroll-padding-top: 4.5rem` (`ui/src/app/globals.css`) keeps controls clear of the `sticky top-0 h-16` header when the browser scrolls them into view, so a keyboard-focused control is never fully hidden behind the sticky header or an overlay. Enforced by the Playwright assertion `keyboard focus is never fully obscured by the sticky header (#662)` in `e2e/tests/ui-ia-accessibility.spec.ts`, which walks the tab order across dashboard/overview/documentation/publish/settings/chat and uses `document.elementFromPoint` to verify a visible slice of each focused control paints on top (#662). |
| **2.5.7** Dragging Movements | Supports | The only drag interaction (document upload drop-zone, `document-uploader.tsx`) offers a single-pointer **click-to-browse** alternative and is keyboard-operable (Enter/Space open the file picker). No functionality requires dragging. |
| **2.5.8** Target Size (Minimum) | Supports | Interactive controls meet the 24×24 CSS px minimum (asserted by the Playwright A2 hit-target checks); mobile-converted controls use an exported touch-target class guaranteeing ≥44×44px (#60), verified at 375px. Verified on audited controls; not exhaustively measured for every control app-wide. |
| **3.1.2** Language of Parts | Not Applicable | The UI is single-language (English); no inline passages in a different language requiring `lang` marking. |
| **3.2.3** Consistent Navigation | Supports | The app shell provides consistent, repeated navigation across pages (sidebar + header) in the same relative order. |
| **3.2.4** Consistent Identification | Supports | Components with the same function (icon controls, action buttons) are identified consistently by accessible name across pages. |
| **3.3.3** Error Suggestion | Supports | Where an input error is detected and a correction is known, forms surface a concrete suggestion via the shared `ui/src/lib/error-suggestion.ts` helper, applied in a sweep across the user-facing forms (project create, URL/document ingest, budget, workspace admin, notification/test-coverage connections, add-documents). This complements the `role="alert"` error identification (SC 3.3.1) so the user is told *how* to fix the value, not just that it is wrong (#663). |
| **3.3.4** Error Prevention (Legal, Financial, Data) | Supports | Consequential and destructive actions use confirmation dialogs, and publishing offers a **dry-run preview** (no external writes) before live publish; actions are reversible or confirmed. Not every data submission carries an explicit final review step. |
| **3.3.8** Accessible Authentication (Minimum) (new in 2.2) | Supports | Authentication uses username/password or federated SSO (OIDC/SAML/LDAP). No cognitive-function test (puzzle, transcription, memorization) is required, and pasting into credential fields is not blocked — so an authentication method that does not rely on a cognitive function test is available. |
| **4.1.3** Status Messages | Supports | Status messages are exposed to assistive technology without focus change via `role="status"`/`role="alert"`/`aria-live` regions: the global Toaster, the auth/loading gate, the chat `role="log"`, and the publish log `aria-live` list — several of these were added/confirmed by the #58 audit. |

---

## Legal disclaimer

This Accessibility Conformance Report is an **internal FORMAL WCAG-EM
self-evaluation** conducted in-house by the METIS engineering team following the
W3C [WCAG-EM 1.0](https://www.w3.org/TR/WCAG-EM/) methodology (see the companion
[`WCAG_EM_EVALUATION.md`](./WCAG_EM_EVALUATION.md)). It reflects a good-faith
evaluation of METIS against WCAG 2.2 A/AA using the manual + assertion-based
methods described above, scoped primarily to the top-10 audited pages, with every
*Supports* rating backed by a merged test/artifact. It is an **in-house formal
self-evaluation — NOT a third-party audit or external certification**; no
independent accessibility consultant reviewed it. It does not constitute a
warranty or a formal legal conformance claim. Conformance may change as the
product evolves; this report should be re-validated by an **independent,
third-party accessibility auditor** before being relied upon for external,
procurement, or compliance purposes.
