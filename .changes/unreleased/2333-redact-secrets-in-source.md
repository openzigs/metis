---
issue: 2333
section: Security
---

- Secrets in repository files (API keys, private keys, passwords in URLs, values assigned to a
  password, token or key setting) no longer reach the knowledge index, the code graph or the file
  reader. Each is replaced on its own line by a marker naming its kind, so line numbers and
  citations stay the same. Emails and phone numbers in source code are left alone, so a Go version
  is no longer read as a phone number (#1138).
- One shared pattern list now serves connectors, source and the agent/skill credential check, and adds
  private keys, URL passwords, AWS secret access keys and more vendor keys. A bare private-key header
  is no longer refused, nor is Stripe's published `sk_test_` key; other vendor key shapes are.
- **Operators:** to remove secrets already indexed, sync each repository connector; files that held a
  secret are re-indexed and the rest skipped. The next code-graph ingest rewrites stored symbol text.
