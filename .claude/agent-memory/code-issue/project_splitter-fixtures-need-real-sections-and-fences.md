# Test splitters on a real section and on code fences

Any fix that batches or splits LLM input (claim passages, section batches) must
be tested on (a) a real section from `server/dev.db`, read-only, and (b) markdown
with a large or **unclosed** code fence.

Measured on PR #162 (#152): synthetic bullet-list fixtures never contain fences,
and a splitter that keeps fences whole handed a ~20k-char fenced block (and
everything after an unclosed fence) back as one passage — reproducing the very
overflow the fix was for. The same review validated the splitter against run 7's
real 30,715-char Formulas section (7 passages, no lines lost). Filed as #165.
Formula-heavy SAS documentation commonly puts formulas in code blocks.
