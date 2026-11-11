---
issue: 2272
section: Added
---

- The portfolio check can check a document: **Check requirements across portfolio** on a
  project's Documents page checks each requirement in it on its own, not the whole FRD as one
  cut at 8,000 characters. A check can also look at several chosen products (up to 50).
- Nothing is cut silently: **Not checked**, on the page and in the export, lists what the check
  did not check and why. Each product the change reaches says how sure the impact is:
  **Found in code** (a product that must change), **Verified by graph path** (downstream),
  **Likely**, **Possible** or **Needs review**.
