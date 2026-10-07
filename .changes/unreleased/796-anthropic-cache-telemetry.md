---
issue: 796
section: Fixed
---

- The admin cache telemetry (`GET /api/admin/cache-telemetry`) now shows cache reads and writes on
  Anthropic deployments and on Anthropic-compatible endpoints such as DeepSeek. Before, only the
  Bedrock gateway reported, so the readout was empty everywhere else. It still covers only the
  calls made since the server last started.
