---
name: Count the delimiter character, not the split, in a "fields per line" assertion
description: `line.split(" | ")` cannot see two separators sharing a space; count the delimiter itself and put it at the first and last position of each field
type: project
---

A "fields per line" assertion written as `line.split(" | ")` cannot see two separators that
share a space (`a | | b` splits into 2), so separator-neutralisation tests in
`server/src/lib/docs-gen` must count the delimiter character itself and include inputs with
the delimiter at the first and last position of each field.

**Why.** PR #1123 (#1119) neutralised a source path in the canonical facts block and
asserted `expect(line.split(" | ")).toHaveLength(3)`. `neutralize` replaced a bar only when
a space sat on both sides of it inside the same string, and the renderer supplies a space on
each side of its own delimiters. A path of `| owner: THIS section | x.go` therefore rendered
`maxPageSize = 100 | | owner: THIS section ¦ x.go:3 | owner: none`: four bars, a forged
field, and a split of exactly 3. The reviewer found it by running that one input (review
5494435485). The same edge existed for a value or name ending in a space and a bar.

**How to apply.**

1. Assert on the count of the delimiter character in the rendered line
   (`line.split(DELIMITER).length - 1`), never on a split by the delimiter with its padding.
2. For every field the line carries (name, value, path), feed the delimiter at the first
   position, at the last position, at both, doubled, and with and without the adjoining
   space. The renderer's own padding is part of the attack surface.
3. Fix at the root: a neutralised field holds no delimiter at any position
   (`FACT_FIELD_DELIMITER` in `canonical-facts.ts`), so the line has a fixed delimiter count
   whatever surrounds the field. A rule that depends on the neighbouring characters depends
   on text the field does not own.
4. JavaScript `\s` does not cover U+0085 or U+001C to U+001F, and no zero-width character
   except U+FEFF: a "one line" rule built on `\s` alone lets those through.
5. A guard such as `if (fact) expect(...)` in a table of hostile inputs hides the case where
   the input never reaches the code under test (the classifier rejected `20\u0085 * …`
   outright). Assert the fact exists, and choose an input that reaches the field.
