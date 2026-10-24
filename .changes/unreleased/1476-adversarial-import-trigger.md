---
issue: 1476
section: Changed
---

- The adversarial review panel now also triggers when a change newly imports a credential or
  egress module (the vault, the secret resolver and binders, the network and host allowlists,
  the GitHub client factory, the SSRF-guarded fetch and its dispatchers), wherever the
  importing file lives. A file that read a vault secret and built a credentialed GitHub client
  previously got no panel because its name carried no security word.
