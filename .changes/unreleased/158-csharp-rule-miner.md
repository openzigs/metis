---
issue: 158
section: Added
---

- C# modules now get a deterministic rule inventory in business-requirements
  generation: guard clauses, `ThrowIf`/`Guard.Against` helpers, thrown
  exceptions, `[Required]`/`[Range]`/`[RegularExpression]` and other validation
  attributes, FluentValidation rules, `switch` on a status or enum, and
  constants and comparisons against them. An `if` that only logs is not
  reported as a rule; one that logs and then returns or throws is. The rules
  are saved with the other languages' mined rules and reach the Rules section.
