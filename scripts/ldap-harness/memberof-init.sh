#!/bin/bash
# =============================================================================
# memberof-init.sh — first-boot seed for the local LDAP harness (#1381).
#
# Mounted at /docker-entrypoint-initdb.d/ in docker-compose.ldap.yml. The
# bitnamilegacy/openldap image runs it once, after its own initialisation and
# with slapd stopped.
#
# WHY a script and not LDAP_CUSTOM_LDIF_DIR: the image loads custom LDIFs before
# any hook can load the memberof overlay, and `memberOf` is not in the schema
# without that overlay. The old seed stamped `memberOf` by hand and failed with
# `memberOf: attribute type undefined` (err=17). So this script:
#
#   1. starts slapd in the background,
#   2. loads memberof.so and configures the overlay on the data database,
#   3. adds bootstrap.ldif — users first, then groups — so the overlay writes
#      each user's `memberOf` from the groups' `member` values,
#   4. stops slapd again; the image's entrypoint then starts it for real.
# =============================================================================
set -o errexit
set -o nounset
set -o pipefail

# shellcheck disable=SC1091
. /opt/bitnami/scripts/libos.sh
# shellcheck disable=SC1091
. /opt/bitnami/scripts/libopenldap.sh
eval "$(ldap_env)"

SEED_LDIF="${METIS_LDAP_SEED_LDIF:-/metis-ldap/bootstrap.ldif}"

ldap_start_bg

ldap_load_module "/opt/bitnami/openldap/lib/openldap" "memberof.so"

cat > "${LDAP_SHARE_DIR}/metis_memberof_overlay.ldif" <<EOF
dn: olcOverlay=memberof,olcDatabase={2}mdb,cn=config
objectClass: olcOverlayConfig
objectClass: olcMemberOf
olcOverlay: memberof
olcMemberOfDangling: ignore
olcMemberOfRefInt: TRUE
olcMemberOfGroupOC: groupOfNames
olcMemberOfMemberAD: member
olcMemberOfMemberOfAD: memberOf
EOF
ldapadd -Q -Y EXTERNAL -H "ldapi:///" -f "${LDAP_SHARE_DIR}/metis_memberof_overlay.ldif"

ldapadd -H "ldapi:///" -D "${LDAP_ADMIN_DN}" -w "${LDAP_ADMIN_PASSWORD}" -f "${SEED_LDIF}"

ldap_stop
