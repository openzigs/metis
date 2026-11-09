---
issue: 2128
section: Fixed
---

- When an answer given on one requirement settles a company-policy rule on another, the reason now
  says "the analyst's answer" instead of the internal label "A1".
- A clarifying question no longer shows a requirement's internal id, such as
  "(id: 6280ae21-…)". It names the requirement by its title.
- A governing finding quotes the whole sentence of the policy clause it cites, so a re-checked quote
  keeps its subject and its final period.
- The clarification progress now counts answers to company-policy questions from earlier rounds, so
  round 2 no longer opens at "0 addressed". The totals read "questions addressed" instead of
  "ambiguities addressed".
