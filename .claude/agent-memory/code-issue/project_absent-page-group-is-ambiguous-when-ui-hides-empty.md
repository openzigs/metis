---
name: absent-page-group-is-ambiguous-when-ui-hides-empty
description: A walkthrough brief that keys a fallback on a page group being absent is ambiguous when the UI hides empty groups.
metadata:
  type: project
---

A walkthrough brief that keys a fallback on a page group being absent is ambiguous whenever the UI hides empty groups, as `ui/src/components/impact/changed-requirement-group.tsx` does. Check the component's render condition before accepting a rule based on a group's absence.

On PR #1125 (#1073), TEST_PLAN and the wave E brief read "no Files to edit group" as "METIS before #1036". The component renders that group only when `editCandidates.length > 0`, and the list can be empty beside a non-empty blast radius (`server/src/lib/impact-analysis/change-seeds.ts` admits only production, non-schema hits as edit candidates).

**Why:** absence has two causes, an older page and an empty list, and the brief named one.

**How to apply:** key the fallback on something the other version positively shows. Here that is the old card's headline, "N directly affected across M files", which is rendered unconditionally; the old page had no "Probable call sites" heading (read at `12ed4bb6^`). State the empty case outright.
