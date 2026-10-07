---
issue: 763
section: Fixed
---

- Requirement import can use an existing vault secret. The Import page's credential
  defaults to the `${vault:label}` picker, and the server checks the secret's ownership
  and binds it by id. Deleting an import source no longer deletes a secret it only
  referred to.
- A public GitHub repository can be previewed and imported without a token, with a
  warning about the anonymous rate limit. A `${vault:…}` value pasted into the token
  field is refused instead of being stored as a literal token.
