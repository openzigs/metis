---
issue: 307
section: Changed
---

- The local embedders now run on `@huggingface/transformers` 4.3.0 with `onnxruntime-node`
  pinned to 1.22.0, which keeps every stored vector valid (cos 1.0000 against 3.8.1), so no
  re-embed is needed. A parity gate on dependency PRs enforces the pin. Also fixes the 2,048-token
  embed cap, which v4 silently dropped in the embed worker.
