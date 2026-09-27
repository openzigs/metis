---
issue: 265
section: Fixed
---

- The Light/Dark theme toggle now controls every surface. `dark:` styles used to
  follow the operating system, so choosing Light on a dark OS left dark panels
  on a light page. The Templates heading and the Analysis panels now use theme
  colours and are readable (at least 4.5:1) in both themes.
- Dialog, sheet, tooltip and menu open/close animations now run. The UI moved
  to the single `radix-ui` package and picked up patch/minor updates to its
  icon, toast, zoom and diff-viewer libraries.
