---
issue: 1381
section: Fixed
---

- The local LDAP harness starts again: it pins `bitnamilegacy/openldap:2.6` by digest
  (`bitnami/openldap` was removed from Docker Hub) and enables the memberof overlay so
  `memberOf` is derived from the groups instead of being rejected. A new `ldap-harness`
  workflow boots it and logs in through METIS's LDAP provider.
