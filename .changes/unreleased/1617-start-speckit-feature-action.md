---
issue: 1617
section: Added
---

- The analysis page's requirements list has a **Start Spec Kit feature**
  action. Tick approved requirements and press it: METIS creates a Spec Kit
  feature whose `spec.md` lists every one of them and opens it on the Spec Kit
  page. The action stays disabled, with the reason on hover, while any ticked
  requirement is not approved. If the server refuses some, their ids are
  listed under the action.
