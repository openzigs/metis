---
issue: 2333
section: Security
---

- Secrets in repository files (API keys, private keys, passwords in URLs, values assigned to a
  password, token or key setting) no longer reach the knowledge index, the code graph or the file
  reader. Each is replaced on its own line by a marker naming its kind, so line numbers and
  citations stay the same. Emails and phone numbers in source code are left alone (#1138).
- One shared pattern list now serves connectors, source, the sandbox audit log and the agent/skill
  credential check. A bare private-key header, Stripe's `sk_test_` key and Slack's documented
  webhook placeholder are no longer refused; other vendor key shapes are.
- **Operators:** sync each repository connector to remove secrets already indexed: files that held
  one are re-indexed and their old stored copy deleted. The next code-graph ingest does the rest.
