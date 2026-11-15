---
issue: 2521
section: Fixed
---

- `eval:ba-qa`: the judge's verdict is read from the last fenced ` ```json ` block in its reply,
  or else from the last `{ … }` object that has the verdict's shape. A reply with braces in its
  prose before the JSON (`{base_url}/v1{path}`), or with a corrected second verdict after the
  first, was left unscored because the parser sliced from the first `{` to the last `}`; both
  are now scored, with the judge's last verdict. A reply with no valid verdict is still unscored.
  A `{"behaviour": …}` aside in prose after the verdict no longer replaces it.
