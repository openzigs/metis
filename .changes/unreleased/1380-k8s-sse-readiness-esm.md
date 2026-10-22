---
issue: 1380
section: Fixed
---

- With `MCP_RUNTIME=k8s-sse`, `/readyz` no longer reports the kubeconfig check
  as failed on every call. The check loaded the Kubernetes client with
  `require()`, which does not exist in the server's ES module build.
