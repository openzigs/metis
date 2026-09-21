# SSO Integration: Okta

Step-by-step guide to configure Okta as an SSO identity provider for METIS.

## Prerequisites

- Okta administrator account
- METIS instance with network access from Okta
- METIS admin role to configure SSO

## SAML 2.0 Setup

### 1. Create SAML Application in Okta

1. Log in to your Okta Admin Console
2. Navigate to **Applications** → **Applications** → **Create App Integration**
3. Select **SAML 2.0** and click **Next**
4. Configure:
   - **App name**: `METIS`
   - **App logo**: Upload the METIS logo (optional)
5. Click **Next**

### 2. Configure SAML Settings

| Field | Value |
|-------|-------|
| Single sign-on URL | `https://<your-metis-url>/api/auth/saml/acs` |
| Audience URI (SP Entity ID) | `https://<your-metis-url>/sp` |
| Name ID format | EmailAddress |
| Application username | Email |

### 3. Attribute Statements

| Name | Value |
|------|-------|
| `email` | `user.email` |
| `displayName` | `user.displayName` |
| `groups` | (Group attribute statement — see below) |

### 4. Group Attribute Statement

1. Name: `groups`
2. Filter: **Matches regex** `.*` (or filter to specific groups)

### 5. Download IdP Metadata

1. On the **Sign On** tab of your application, click **Identity Provider metadata**
2. Copy the XML content

### 6. Configure METIS

1. Navigate to **Admin** → **Authentication** → **SAML 2.0** tab
2. Paste the IdP Metadata XML
3. Set **SP Entity ID** to match the Audience URI above
4. Set **ACS URL** to match the Single sign-on URL above
5. Enable the provider
6. Configure group → role mappings

## OIDC Setup (Alternative)

### 1. Create OIDC Application in Okta

1. Navigate to **Applications** → **Create App Integration**
2. Select **OIDC - OpenID Connect** → **Web Application**
3. Configure:
   - **App name**: `METIS`
   - **Grant type**: Authorization Code
   - **Sign-in redirect URIs**: `https://<your-metis-url>/api/auth/oidc/callback`
   - **Sign-out redirect URIs**: `https://<your-metis-url>/login`

### 2. Note Credentials

- **Client ID**: Copy from the application's General tab
- **Client Secret**: Copy from the application's General tab
- **Discovery URL**: `https://<your-okta-domain>/.well-known/openid-configuration`

### 3. Configure METIS

1. Navigate to **Admin** → **Authentication** → **OIDC** tab
2. Enter Discovery URL, Client ID, and Client Secret
3. Set Redirect URI
4. Enable the provider

## SCIM Provisioning

### 1. Enable SCIM in Okta

1. Go to your METIS application in Okta
2. Navigate to **Provisioning** → **Configure API Integration**
3. Check **Enable API Integration**
4. Enter:
   - **SCIM connector base URL**: `https://<your-metis-url>/api/scim/v2`
   - **API Token**: Generate from METIS Admin → Authentication → SCIM tab

### 2. Configure Provisioning

Enable the following:
- ✅ Create Users
- ✅ Update User Attributes
- ✅ Deactivate Users
- ✅ Push Groups

## Troubleshooting

| Issue | Solution |
|-------|----------|
| SAML response validation fails | Ensure clock skew is <5 minutes between Okta and METIS |
| Groups not appearing | Verify the group attribute statement filter matches your groups |
| SCIM sync errors | Check SCIM token hasn't expired; rotate if needed |
