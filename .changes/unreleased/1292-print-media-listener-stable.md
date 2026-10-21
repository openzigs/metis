---
issue: 1292
section: Fixed
---

- Printing a long document no longer misses the switch to print media in browsers that report it
  only through `matchMedia('print')`: the previewer keeps one print listener for the document
  instead of re-subscribing on every lazy render, and renders everything at once if print media
  is already active when it subscribes.
