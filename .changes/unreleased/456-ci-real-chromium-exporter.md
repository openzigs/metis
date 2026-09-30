---
issue: 456
section: Changed
---

- CI: the `server` job installs puppeteer's Chrome and runs the real-Chromium exporter integration suite, so a PDF / DOCX export that cannot launch Chromium fails the build.
