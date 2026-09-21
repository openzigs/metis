# SSO Integration: Keycloak

Step-by-step guide to configure Keycloak as an SSO identity provider for METIS.

> **Just want to try it locally?** See the
> [local OIDC test harness](./oidc-local-testing.md) (Issue #521): one command
> (`make oidc-up`) spins up Keycloak with a pre-imported realm and seeds the METIS
> OIDC provider, including end-to-end IdP-group→role mapping.

## Prerequisites

- Keycloak server (v20+) with admin access
- METIS instance accessible from Keycloak
- METIS admin role to configure SSO

## SAML 2.0 Setup

### 1. Create SAML Client

1. Log in to **Keycloak Admin Console**
2. Select your realm
3. Go to **Clients** → **Create client**
4. Configure:
   - **Client type**: SAML
   - **Client ID**: `https://<your-metis-url>/sp`
5. Click **Next**

### 2. Configure Client Settings

| Field | Value |
|-------|-------|
| Root URL | `https://<your-metis-url>` |
| Valid redirect URIs | `https://<your-metis-url>/api/auth/saml/acs` |
| Master SAML Processing URL | `https://<your-metis-url>/api/auth/saml/acs` |
| Name ID Format | email |
| Force Name ID Format | ON |

### 3. Configure Mappers

Add protocol mappers for attributes:

1. **Email**: Built-in mapper (User Property → email)
2. **Display Name**: User Property → `firstName` + `lastName`
3. **Groups**:
   - Mapper type: Group Membership
   - Token Claim Name: `groups`
   - Full group path: OFF

### 4. Download IdP Metadata

Navigate to: `https://<keycloak-url>/realms/<realm>/protocol/saml/descriptor`

Copy the XML content.

### 5. Configure METIS

1. Navigate to **Admin** → **Authentication** → **SAML 2.0** tab
2. Paste the realm SAML descriptor XML
3. Set Entity ID to match the Keycloak Client ID
4. Enable the provider

## OIDC Setup (Recommended)

### 1. Create OIDC Client

1. Go to **Clients** → **Create client**
2. Configure:
   - **Client type**: OpenID Connect
   - **Client ID**: `metis`
3. Click **Next**
4. Configure:
   - **Client authentication**: ON
   - **Authorization**: OFF
   - **Authentication flow**: ✅ Standard flow
5. Click **Next**
6. Set:
   - **Valid redirect URIs**: `https://<your-metis-url>/api/auth/oidc/callback`
   - **Web origins**: `https://<your-metis-url>`

### 2. Client Secret

1. Go to the client → **Credentials** tab
2. Copy the **Client secret**

### 3. OIDC Endpoints

- **Discovery URL**: `https://<keycloak-url>/realms/<realm>/.well-known/openid-configuration`
- **Client ID**: `metis`
- **Client Secret**: From step 2

### 4. Add Group Mapper

1. Go to the client → **Client scopes** → `metis-dedicated`
2. Add mapper → **Group Membership**
3. Token Claim Name: `groups`
4. Full group path: OFF

### 5. Configure METIS

1. Navigate to **Admin** → **Authentication** → **OIDC** tab
2. Enter Discovery URL, Client ID, and Client Secret
3. Enable the provider

## SCIM Provisioning

Keycloak supports SCIM via extensions:

### Using keycloak-scim (Community Extension)

1. Install the SCIM extension in Keycloak
2. Configure the SCIM client:
   - **Endpoint URL**: `https://<your-metis-url>/api/scim/v2`
   - **Bearer Token**: Generate from METIS Admin → Authentication → SCIM tab
3. Enable user and group sync

### Manual Provisioning

If SCIM extension is not available:
1. Use Keycloak's Event Listeners to trigger provisioning on user events
2. Call METIS SCIM endpoints via the Admin REST API

## MFA Integration

Keycloak MFA status is detected via:
- **OIDC**: `amr` claim includes MFA methods (e.g., `otp`)
- **SAML**: `AuthnContextClassRef` set to appropriate MFA class

Configure in Keycloak:
1. Go to **Authentication** → **Flows**
2. Add OTP or WebAuthn as required action
3. The MFA status will automatically propagate to METIS

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Invalid redirect URI | Ensure exact match including scheme and path |
| No groups in token | Verify Group Membership mapper is added to the client scope |
| SAML signature failure | Check realm signing key matches the metadata certificate |
| Clock skew errors | Ensure Keycloak and METIS servers have synced clocks (NTP) |
