# =============================================================================
# METIS Makefile — local Kubernetes / Helm chart validation targets.
#
# Issue #545 (Epic #518). These targets let a developer reproduce the CI
# `chart-validate` workflow (.github/workflows/chart-validate.yml) locally:
#
#   make chart-validate   # offline: helm lint + template + render-tests.sh
#   make kind-smoke        # + throwaway kind cluster install smoke
#   make k3d-test          # alias for kind-smoke (the canonical local target)
#
# Requires: helm (v3+) for chart-validate; plus kind, kubectl, Docker for the
# cluster smoke. See docs/EKS_DEPLOYMENT.md §7b "Local chart validation".
#
# Issue #523 (Epic #517) adds the local SAML test harness targets:
#
#   make saml-up         # gen keys, start the mock SAML IdP, seed METIS
#   make saml-down       # stop the mock SAML IdP (keeps keys)
#
# Issue #521 (Epic #517) adds the local OIDC test harness targets:
#
#   make oidc-up         # start Keycloak (realm import), seed METIS OIDC provider
#   make oidc-down       # stop Keycloak
#
# Issue #525 (Epic #517) adds the local LDAP test harness targets:
#
#   make ldap-up         # start OpenLDAP (LDIF seed), verify dir, print AUTH_LDAP_*
#   make ldap-down       # stop OpenLDAP (and remove its data volume)
#
# See docs/auth/saml-local-testing.md, docs/auth/oidc-local-testing.md and
# docs/auth/ldap-local-testing.md.
# =============================================================================
.PHONY: chart-validate kind-smoke k3d-test saml-up saml-down oidc-up oidc-down ldap-up ldap-down help

help:
	@echo "METIS chart-validation targets:"
	@echo "  make chart-validate  - offline helm lint + template + render-tests (no cluster)"
	@echo "  make kind-smoke      - create a kind cluster, install the chart, assert objects"
	@echo "  make k3d-test        - alias for kind-smoke (canonical local k8s validation)"
	@echo "METIS local-auth harness targets:"
	@echo "  make saml-up         - start the mock SAML IdP and seed the METIS SAML provider"
	@echo "  make saml-down       - stop the mock SAML IdP"
	@echo "  make oidc-up         - start Keycloak (realm import) and seed the METIS OIDC provider"
	@echo "  make oidc-down       - stop Keycloak"
	@echo "  make ldap-up         - start OpenLDAP (LDIF seed), verify the directory, print AUTH_LDAP_*"
	@echo "  make ldap-down       - stop OpenLDAP"

# Offline gate — fast inner loop, no cluster or Docker required.
chart-validate:
	bash scripts/chart-validate.sh

# Full local smoke: throwaway kind cluster + helm install + object assertions.
kind-smoke:
	bash scripts/kind-smoke.sh

# Canonical local k8s validation entrypoint (issue #545 acceptance criterion).
# kind is the maintained local-cluster tool in this repo (helm/kind-action in
# CI); k3d is interchangeable. This target wraps the kind smoke.
k3d-test: kind-smoke

# Local SAML test harness (#523). Brings up boxyhq/mock-saml as a local IdP and
# seeds the METIS SAML provider so SAML login can be exercised end-to-end with
# #520's secure response-signing defaults. Requires a running METIS server
# (AUTH_MODE=mock) and Docker.
saml-up:
	bash scripts/saml-harness/up.sh

saml-down:
	bash scripts/saml-harness/down.sh

# Local OIDC test harness (#521). Brings up Keycloak with a deterministically
# imported realm (confidential client + test user + groups + a `groups`-claim
# mapper) and seeds the METIS OIDC provider so the OIDC login + group->role
# mapping can be exercised end-to-end. Requires a running METIS server
# (AUTH_MODE=mock) and Docker.
oidc-up:
	bash scripts/oidc-harness/up.sh

oidc-down:
	bash scripts/oidc-harness/down.sh

# Local LDAP test harness (#525). Brings up OpenLDAP seeded deterministically
# from scripts/ldap-harness/bootstrap.ldif (two users + two groups with explicit
# memberOf), verifies the bind/search/group→role flow METIS's provider performs,
# and prints the exact AUTH_LDAP_* env block. Unlike SAML/OIDC, LDAP is
# ENV-DRIVEN: export that block and start METIS with AUTH_MODE=ldap. Requires
# Docker (a running METIS server is only needed for the optional CONFIGURE=1 pass).
ldap-up:
	bash scripts/ldap-harness/up.sh

ldap-down:
	bash scripts/ldap-harness/down.sh
