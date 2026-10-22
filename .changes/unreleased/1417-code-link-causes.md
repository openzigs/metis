---
issue: 1417
section: Fixed
---

- Code whose embedding the search did not return is no longer shown by the keyword rule: it is
  scored as no closer than the code the search did return, and its confidence is capped just
  under the lowest of those links, so it is listed after them and only if it still clears 0.08.
- The Affected code panel names every cause behind the keyword-rule links it shows, labels each
  link with the rule that showed it where a requirement mixes both, and advises a re-run only for
  code still being embedded.
- On small projects with a database schema, a one-word table such as `sessions` is linked only when
  the requirement shares two words with its name, or is just that word ("Sessions").
