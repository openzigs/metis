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

### 3. Attributes & Claims

Edit the default claims:

| Claim | Source attribute |
|-------|-----------------|
| `emailaddress` | `user.mail` |
| `name` | `user.displayname` |
| `groups` | Groups assigned to the application |

To include group claims:
1. Click **+ Add a group claim**
2. Select **Groups assigned to the application**
3. Source attribute: **Group ID** or **Display Name**

### 4. Download Federation Metadata XML

1. In the **SAML Certificates** section, download **Federation Metadata XML**
2. Copy the entire XML content

### 5. Assign Users/Groups

1. Go to **Users and groups** → **+ Add user/group**
2. Assign the users or groups that should access METIS

### 6. Configure METIS

1. Navigate to **Admin** → **Authentication** → **SAML 2.0** tab
2. Paste the Federation Metadata XML
3. Set SP Entity ID and ACS URL to match Azure AD configuration
4. Enable the provider
5. Map Azure AD group IDs/names to METIS roles

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

Azure AD MFA status is automatically detected via:
- **OIDC**: The `amr` claim in the ID token includes `mfa` when MFA was completed
- **SAML**: The `AuthnContextClassRef` includes `http://schemas.microsoft.com/claims/multipleauthn`

METIS will flag sessions as MFA-confirmed when these claims are present.

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
| SCIM provisioning fails | Check Secret Token is valid; Azure requires SCIM 2.0 compliance |
