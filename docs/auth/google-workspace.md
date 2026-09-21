# SSO Integration: Google Workspace

Step-by-step guide to configure Google Workspace as an SSO identity provider for METIS.

## Prerequisites

- Google Workspace Super Admin account
- METIS instance accessible from Google
- METIS admin role to configure SSO

## SAML 2.0 Setup

### 1. Create Custom SAML App

1. Go to **Google Admin Console** → **Apps** → **Web and mobile apps**
2. Click **Add app** → **Add custom SAML app**
3. Enter app name: `METIS`
4. Download the **IdP metadata** (or note the SSO URL and Certificate)
5. Click **Continue**

### 2. Service Provider Details

| Field | Value |
|-------|-------|
| ACS URL | `https://<your-metis-url>/api/auth/saml/acs` |
| Entity ID | `https://<your-metis-url>/sp` |
| Name ID Format | EMAIL |
| Name ID | Basic Information > Primary email |

### 3. Attribute Mapping

| Google Directory attribute | App attribute |
|----------------------------|---------------|
| Primary email | `email` |
| First name + Last name | `displayName` |

### 4. Configure Group Membership (Optional)

1. Under **Group membership**, add groups that map to METIS roles
2. Note the group email addresses for mapping configuration

### 5. Enable for Users

1. Click the app → **User access**
2. Select the organizational units that should access METIS
3. Set to **ON for everyone** (or specific OUs)

### 6. Configure METIS

1. Navigate to **Admin** → **Authentication** → **SAML 2.0** tab
2. Paste the Google IdP metadata XML
3. Enable the provider
4. Map Google group emails to METIS roles

## OIDC Setup (Alternative)

### 1. Create OAuth 2.0 Credentials

1. Go to **Google Cloud Console** → **APIs & Services** → **Credentials**
2. Click **+ Create Credentials** → **OAuth client ID**
3. Application type: **Web application**
4. Name: `METIS`
5. Authorized redirect URIs: `https://<your-metis-url>/api/auth/oidc/callback`
6. Click **Create**

### 2. Note Credentials

- **Client ID**: Shown after creation
- **Client Secret**: Shown after creation
- **Discovery URL**: `https://accounts.google.com/.well-known/openid-configuration`

### 3. Configure METIS

1. Navigate to **Admin** → **Authentication** → **OIDC** tab
2. Enter Discovery URL, Client ID, and Client Secret
3. Set scopes to: `openid profile email`
4. Enable the provider

## Notes

- Google Workspace does not natively support SCIM to custom apps. Use Google's Directory API for user sync or configure manual provisioning.
- Google's OIDC implementation includes the `hd` (hosted domain) claim which can be used for domain validation.
- MFA status is conveyed via the `amr` claim when using OIDC.

## Troubleshooting

| Issue | Solution |
|-------|----------|
| "app_not_configured_for_user" | Ensure the app is enabled for the user's OU |
| No groups in assertion | Google SAML group membership requires explicit configuration |
| OIDC login loops | Verify redirect URI exactly matches (including trailing slash) |
