---
issue: 450
section: Fixed
---

- Stopping the in-process embedder while a document is being embedded now rejects that call before its next model call with a clear "embedder was closed while embedding" error, instead of an unhandled `this.pipeline is not a function` or a silent switch to a freshly loaded model mid-document. A stop during the document's last model call still returns that call's vectors, all from one model.
