# Filter the capped list, never the uncapped one

Recurring METIS bug shape: a list is rendered under a character/token cap, but a
filter or dedup runs against the **uncapped** list. Items past the cap are then
removed by the filter *and* absent from the render, so they vanish silently.

Measured on PR #163 (#155): `dedupeRulesAgainstMined` compared LLM rule bullets
against every mined rule, while `renderMinedRuleInventory` showed only ~25–33 of
them (4,000-char cap). The review reproduced it with 60 mined rules: the bullet
for rule 59 was deleted and rule 59 appeared nowhere. The suite stayed green
because no test used more rules than the cap.

Fix that works: one shared function returns exactly what fits
(`minedRulesThatFit` in `server/src/lib/docs-gen/fact-slices.ts`), and both the
renderer and the filter call it. Never two separate budget calculations. Test
with more items than the cap.
