# SSO Integration: Azure AD (Entra ID)

Step-by-step guide to configure Azure Active Directory (Microsoft Entra ID) as an SSO identity provider for METIS.

## Prerequisites

- Azure AD tenant with admin access
- METIS instance accessible from Azure
- METIS admin role to configure SSO

## SAML 2.0 Setup

### 1. Create Enterprise Application

1. Go to **Azure Portal** → **Microsoft Entra ID** → **Enterprise applications**
2. Click **+ New application** → **Create your own application**
3. Name: `METIS`
4. Select: **Integrate any other application you don't find in the gallery (Non-gallery)**
5. Click **Create**

### 2. Configure Single Sign-On

1. Go to the METIS app → **Single sign-on** → select **SAML**
2. Edit **Basic SAML Configuration**:

| Field | Value |
|-------|-------|
| Identifier (Entity ID) | `https://<your-metis-url>/sp` |
| Reply URL (ACS URL) | `https://<your-metis-url>/api/auth/saml/acs` |
| Sign on URL | `https://<your-metis-url>/login` |

### 3. SAML Signing Certificate: sign the response and the assertion

Entra's default **Signing Option** is **Sign SAML assertion**, which signs only
the assertion and leaves the Response envelope unsigned. METIS requires the
whole Response to be signed (`requireSignedResponse`, on by default — see
[saml.md](saml.md)), so with the default every sign-in fails with
*"Invalid document signature: the SAML Response envelope is not signed …"*.

1. In **Single sign-on**, find **SAML Signing Certificate** and select **Edit**
2. Set **Signing Option** to **Sign SAML response and assertion**
3. Keep **Signing Algorithm** at **SHA-256**, then **Save**

Do not work around this by turning `requireSignedResponse` off: that gives up
envelope integrity for an IdP that can sign the envelope. Source: Microsoft Learn,
[Certificate signing options in a SAML token](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/certificate-signing-options).

### 4. Attributes & Claims

Entra's default claims are what METIS reads for the account:

| Claim | Source attribute | METIS uses it as |
|-------|-----------------|------------------|
| `http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress` | `user.mail` | e-mail |
| `http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name` | `user.userprincipalname` | display name |

#### Group claim

1. Click **+ Add a group claim**
2. Select **Groups assigned to the application** (recommended)
3. **Source attribute**: **Group ID** (the group's object ID, a GUID)

Entra then sends `http://schemas.microsoft.com/ws/2008/06/identity/claims/groups`,
one value per group object ID. App roles assigned to the user arrive as
`http://schemas.microsoft.com/ws/2008/06/identity/claims/role`. METIS pools the
values of both claims (and of ADFS's `http://schemas.xmlsoap.org/claims/Group`,
`groups` and `memberOf`), so a role mapping in step 7 may name a group object ID
or an app role value.

**Why "Groups assigned to the application".** Entra puts at most **150** groups
in a SAML token, nested groups included. Past that it omits the groups claim
entirely and sends `http://schemas.microsoft.com/claims/groups.link` (a Graph
link) instead. METIS does not call Graph: such a user signs in with the
provider's **default role**, the server logs a `SAML group overage` warning, the
sign-in is recorded as an `sso.saml.group_overage` audit event, and **Admin →
Authentication → SAML 2.0** shows a warning naming the users it happened to.
"Groups assigned to the application" emits only the groups assigned to the METIS
app (direct members only), which keeps users under the limit. Sources: Microsoft
Learn, [Configure group claims for applications](https://learn.microsoft.com/en-us/entra/identity/hybrid/connect/how-to-connect-fed-group-claims)
and [SAML 2.0 token claims reference](https://learn.microsoft.com/en-us/entra/identity-platform/reference-saml-tokens).

### 5. Download Federation Metadata XML

1. In the **SAML Certificates** section, download **Federation Metadata XML**
2. Copy the entire XML content

The file is signed and carries WS-Federation `RoleDescriptor` sections before the
SAML `IDPSSODescriptor`. METIS reads the entity ID
(`https://sts.windows.net/<tenant-id>/`), the HTTP-Redirect SSO URL and the
token-signing certificate from the `IDPSSODescriptor` only; a leading BOM or
whitespace from a pasted file is fine.

### 6. Assign Users/Groups

1. Go to **Users and groups** → **+ Add user/group**
2. Assign the users or groups that should access METIS

### 7. Configure METIS

1. Navigate to **Admin** → **Authentication** → **SAML 2.0** tab
2. Paste the Federation Metadata XML
3. Set SP Entity ID and ACS URL to match Azure AD configuration
4. Enable the provider
5. Map Entra group object IDs (or app role values) to METIS roles; users whose
   groups match no mapping get the default role

## OIDC Setup (Alternative)

### 1. Register Application

1. Go to **Azure Portal** → **App registrations** → **+ New registration**
2. Configure:
   - **Name**: `METIS`
   - **Redirect URI** (Web): `https://<your-metis-url>/api/auth/oidc/callback`
3. Click **Register**

### 2. Configure Authentication

1. Under **Authentication**, ensure the redirect URI is correct
2. Enable **ID tokens** under Implicit grant

### 3. Create Client Secret

1. Go to **Certificates & secrets** → **+ New client secret**
2. Copy the secret value immediately (it won't be shown again)

### 4. Note Endpoints

- **Client ID**: Application (client) ID from Overview
- **Discovery URL**: `https://login.microsoftonline.com/<tenant-id>/v2.0/.well-known/openid-configuration`

### 5. API Permissions

Add these permissions:
- `openid`
- `profile`
- `email`
- `GroupMember.Read.All` (for group claims)

### 6. Configure METIS

1. Navigate to **Admin** → **Authentication** → **OIDC** tab
2. Enter Discovery URL, Client ID, and Client Secret
3. Enable the provider

## MFA Integration

METIS records whether a sign-in used MFA (`mfaPassed` on the session):

- **OIDC**: the `amr` claim in the ID token includes `mfa`.
- **SAML**: either of
  - the assertion's `AuthnContextClassRef` is `MobileTwoFactorContract` or
    `SmartcardPKI` (Entra's classes for Authenticator/SMS/phone MFA and for
    FIDO2, passkeys, Windows Hello and multi-factor CBA), or
  - the `http://schemas.microsoft.com/claims/authnmethodsreferences` claim
    contains `http://schemas.microsoft.com/claims/multipleauthn`, which Entra
    emits only when the user completed MFA. Microsoft documents that SAML apps
    other than Salesforce must request it: add the optional `amr` claim with the
    `include_granular_amr` additional property to the app registration.

A password-only sign-in is **not** MFA: Entra reports it as the `Password` class
and `authenticationmethod/password`, and METIS also does not count
`PasswordProtectedTransport` (a password over TLS) or `X509` (single-factor
certificate) as MFA. Source: Microsoft Learn,
[Single sign-on SAML protocol](https://learn.microsoft.com/en-us/entra/identity-platform/single-sign-on-saml-protocol)
(AuthnStatement and authnmethodsreferences tables).

## SCIM Provisioning

### 1. Enable Provisioning

1. Go to the METIS enterprise app → **Provisioning** → **Get started**
2. Set **Provisioning Mode** to **Automatic**
3. Enter:
   - **Tenant URL**: `https://<your-metis-url>/api/scim/v2`
   - **Secret Token**: Generate from METIS Admin → Authentication → SCIM tab
4. Click **Test Connection** then **Save**

### 2. Configure Attribute Mappings

Default mappings should work. Ensure:
- `userName` maps to `userPrincipalName`
- `displayName` maps to `displayName`
- `emails[type eq "work"].value` maps to `mail`

## Troubleshooting

| Issue | Solution |
|-------|----------|
| "AADSTS50011" error | Ensure Reply URL exactly matches ACS URL (no trailing slash) |
| No group claims | Verify group claim is configured and users are assigned to groups |
| "Invalid document signature: the SAML Response envelope is not signed" | Set **SAML Signing Certificate → Signing Option** to **Sign SAML response and assertion** (step 3) |
| A user gets the default role; the SAML 2.0 tab warns of a group overage | The user is in more than 150 groups: set the group claim to **Groups assigned to the application** (step 4) |
| Mapping by group name does nothing | Entra sends group object IDs by default: map the GUID, not the display name |
| SCIM provisioning fails | Check Secret Token is valid; Azure requires SCIM 2.0 compliance |
