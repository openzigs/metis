"use client";

/**
 * Admin SSO configuration page — tabbed UI for SAML, OIDC, SCIM, and Mappings.
 *
 * Epic #748, Issue #756: Admin UI: /admin/auth configuration.
 * RBAC: admin only.
 */
import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAuth } from "@/lib/auth-context";

/**
 * Admin view of an SSO provider (Issue #451): the config-read API masks stored
 * secrets, so the nested saml/oidc blocks expose non-secret config plus `has*`
 * presence flags — never the raw client secret, SP private key, certs, or IdP
 * metadata XML. Secret form fields stay blank on load; the admin re-enters a
 * value only to change it.
 */
interface SSOProvider {
  id?: string;
  name: string;
  mode: "saml" | "oidc";
  enabled: boolean;
  groupMappings: Array<{ claimValue: string; role: string }>;
  defaultRole: string;
  saml?: {
    entityId?: string;
    acsUrl?: string;
    idpSsoUrl?: string;
    idpIssuer?: string;
    signRequests?: boolean;
    hasSpPrivateKey?: boolean;
    hasSpCert?: boolean;
    hasIdpCerts?: boolean;
    hasIdpMetadataXml?: boolean;
  };
  oidc?: {
    discoveryUrl?: string;
    clientId?: string;
    redirectUri?: string;
    scopes?: string[];
    pkceEnabled?: boolean;
    hasClientSecret?: boolean;
  };
}

export default function AdminAuthPage() {
  const { user } = useAuth();
  const [_providers, setProviders] = useState<SSOProvider[]>([]);
  const [scimToken, setScimToken] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // SAML form state
  const [samlName, setSamlName] = useState("SAML Provider");
  const [samlEntityId, setSamlEntityId] = useState("");
  const [samlAcsUrl, setSamlAcsUrl] = useState("");
  const [samlMetadata, setSamlMetadata] = useState("");
  const [samlMetadataConfigured, setSamlMetadataConfigured] = useState(false);
  const [samlEnabled, setSamlEnabled] = useState(false);

  // OIDC form state
  const [oidcName, setOidcName] = useState("OIDC Provider");
  const [oidcDiscoveryUrl, setOidcDiscoveryUrl] = useState("");
  const [oidcClientId, setOidcClientId] = useState("");
  const [oidcClientSecret, setOidcClientSecret] = useState("");
  const [oidcSecretConfigured, setOidcSecretConfigured] = useState(false);
  const [oidcRedirectUri, setOidcRedirectUri] = useState("");
  const [oidcEnabled, setOidcEnabled] = useState(false);

  // Mapping form state
  const [mappings, setMappings] = useState<Array<{ claimValue: string; role: string }>>([
    { claimValue: "", role: "reader" },
  ]);
  const [defaultRole, setDefaultRole] = useState("reader");

  // LDAP form state
  const [ldapUrl, setLdapUrl] = useState("");
  const [ldapBaseDN, setLdapBaseDN] = useState("");
  const [ldapBindDN, setLdapBindDN] = useState("");
  const [ldapBindPassword, setLdapBindPassword] = useState("");
  const [ldapUserSearchBase, setLdapUserSearchBase] = useState("");
  const [ldapSearchFilter, setLdapSearchFilter] = useState(
    "(&(objectClass=user)(sAMAccountName={{username}}))",
  );
  const [ldapTlsSkipVerify, setLdapTlsSkipVerify] = useState(false);
  const [ldapConfigured, setLdapConfigured] = useState(false);
  const [ldapTestResult, setLdapTestResult] = useState<string | null>(null);

  const fetchProviders = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/auth/providers");
      if (res.ok) {
        const body = await res.json();
        setProviders(body.data?.providers ?? []);
        // Pre-populate forms from existing providers
        const saml = (body.data?.providers ?? []).find((p: SSOProvider) => p.mode === "saml");
        if (saml) {
          setSamlName(saml.name);
          setSamlEntityId(saml.saml?.entityId ?? "");
          setSamlAcsUrl(saml.saml?.acsUrl ?? "");
          // Issue #451: raw IdP metadata XML is no longer returned on read.
          // Leave the textarea blank; surface a "configured" affordance instead.
          // Submitting the SAML form with a blank metadata field keeps the
          // stored XML server-side (see mergeSecretOnUpdate / SAML save guard).
          setSamlMetadata("");
          setSamlMetadataConfigured(saml.saml?.hasIdpMetadataXml ?? false);
          setSamlEnabled(saml.enabled);
          if (saml.groupMappings?.length) setMappings(saml.groupMappings);
          if (saml.defaultRole) setDefaultRole(saml.defaultRole);
        }
        const oidc = (body.data?.providers ?? []).find((p: SSOProvider) => p.mode === "oidc");
        if (oidc) {
          setOidcName(oidc.name);
          setOidcDiscoveryUrl(oidc.oidc?.discoveryUrl ?? "");
          setOidcClientId(oidc.oidc?.clientId ?? "");
          // Issue #451: the client secret is never returned — keep the field
          // blank. Submitting blank keeps the stored secret (server guard).
          setOidcClientSecret("");
          setOidcSecretConfigured(oidc.oidc?.hasClientSecret ?? false);
          setOidcRedirectUri(oidc.oidc?.redirectUri ?? "");
          setOidcEnabled(oidc.enabled);
          if (oidc.groupMappings?.length) setMappings(oidc.groupMappings);
          if (oidc.defaultRole) setDefaultRole(oidc.defaultRole);
        }
      }
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    fetchProviders();
    fetchLDAPConfig();
  }, [fetchProviders]);

  const fetchLDAPConfig = async () => {
    try {
      const res = await fetch("/api/admin/auth/ldap");
      if (res.ok) {
        const body = await res.json();
        const cfg = body.data?.ldap;
        if (cfg) {
          setLdapUrl(cfg.url ?? "");
          setLdapBaseDN(cfg.baseDN ?? "");
          setLdapBindDN(cfg.bindDN ?? "");
          setLdapUserSearchBase(cfg.userSearchBase ?? "");
          setLdapSearchFilter(
            cfg.searchFilter ?? "(&(objectClass=user)(sAMAccountName={{username}}))",
          );
          setLdapTlsSkipVerify(cfg.tlsSkipVerify ?? false);
          setLdapConfigured(cfg.configured ?? false);
        }
      }
    } catch {
      /* ignore */
    }
  };

  const saveLDAP = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/auth/ldap", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: ldapUrl,
          baseDN: ldapBaseDN,
          bindDN: ldapBindDN,
          bindPassword: ldapBindPassword || undefined,
          userSearchBase: ldapUserSearchBase,
          searchFilter: ldapSearchFilter,
          tlsSkipVerify: ldapTlsSkipVerify,
          groupMappings: mappings.filter((m) => m.claimValue),
          defaultRole,
        }),
      });
      if (res.ok) {
        setMessage("LDAP configuration saved");
        setLdapBindPassword("");
        fetchLDAPConfig();
      } else {
        const body = await res.json();
        setMessage(body.error?.message ?? "Failed to save");
      }
    } catch {
      setMessage("Network error");
    } finally {
      setSaving(false);
    }
  };

  const testLDAP = async () => {
    setLdapTestResult(null);
    try {
      const res = await fetch("/api/admin/auth/ldap/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: ldapUrl,
          baseDN: ldapBaseDN,
          bindDN: ldapBindDN,
          bindPassword: ldapBindPassword || undefined,
          tlsSkipVerify: ldapTlsSkipVerify,
        }),
      });
      const body = await res.json();
      if (res.ok) {
        setLdapTestResult("✓ Connection successful");
      } else {
        setLdapTestResult(body.error?.message ?? "Connection failed");
      }
    } catch {
      setLdapTestResult("Network error");
    }
  };

  const saveSAML = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/auth/providers/saml", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: samlName,
          entityId: samlEntityId,
          acsUrl: samlAcsUrl,
          idpMetadataXml: samlMetadata,
          enabled: samlEnabled,
          groupMappings: mappings.filter((m) => m.claimValue),
          defaultRole,
        }),
      });
      if (res.ok) {
        setMessage("SAML configuration saved");
        fetchProviders();
      } else {
        const body = await res.json();
        setMessage(body.error?.message ?? "Failed to save");
      }
    } catch {
      setMessage("Network error");
    } finally {
      setSaving(false);
    }
  };

  const saveOIDC = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/auth/providers/oidc", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: oidcName,
          discoveryUrl: oidcDiscoveryUrl,
          clientId: oidcClientId,
          // Issue #451: send the secret only when the admin typed a new one.
          // Omitting it tells the server to keep the existing stored secret.
          clientSecret: oidcClientSecret || undefined,
          redirectUri: oidcRedirectUri,
          enabled: oidcEnabled,
          groupMappings: mappings.filter((m) => m.claimValue),
          defaultRole,
        }),
      });
      if (res.ok) {
        setMessage("OIDC configuration saved");
        fetchProviders();
      } else {
        const body = await res.json();
        setMessage(body.error?.message ?? "Failed to save");
      }
    } catch {
      setMessage("Network error");
    } finally {
      setSaving(false);
    }
  };

  const rotateScimToken = async () => {
    try {
      const res = await fetch("/api/admin/auth/scim/rotate-token", { method: "POST" });
      if (res.ok) {
        const body = await res.json();
        setScimToken(body.data?.token ?? null);
        setMessage("SCIM token rotated — copy it now, it won't be shown again");
      }
    } catch {
      setMessage("Failed to rotate SCIM token");
    }
  };

  const addMapping = () => {
    setMappings([...mappings, { claimValue: "", role: "reader" }]);
  };

  const removeMapping = (index: number) => {
    setMappings(mappings.filter((_, i) => i !== index));
  };

  const updateMapping = (index: number, field: "claimValue" | "role", value: string) => {
    const updated = [...mappings];
    updated[index] = { ...updated[index], [field]: value };
    setMappings(updated);
  };

  if (user?.role !== "admin") {
    return (
      <div className="p-6">
        <p className="text-destructive">Access denied. Admin role required.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-bold">Authentication Configuration</h1>
        <p className="text-muted-foreground">
          Manage SSO providers, SCIM provisioning, and role mappings.
        </p>
      </div>

      {message && (
        <div className="rounded-md border bg-muted px-3 py-2 text-sm" role="status">
          {message}
        </div>
      )}

      <Tabs defaultValue="saml">
        <TabsList>
          <TabsTrigger value="saml">SAML 2.0</TabsTrigger>
          <TabsTrigger value="oidc">OIDC</TabsTrigger>
          <TabsTrigger value="ldap">LDAP / AD</TabsTrigger>
          <TabsTrigger value="scim">SCIM</TabsTrigger>
          <TabsTrigger value="mappings">Role Mappings</TabsTrigger>
        </TabsList>

        <TabsContent value="saml">
          <Card>
            <CardHeader>
              <CardTitle>SAML 2.0 Configuration</CardTitle>
              <CardDescription>Upload IdP metadata and configure SP settings.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="saml-name">Provider Name</Label>
                <Input
                  id="saml-name"
                  value={samlName}
                  onChange={(e) => setSamlName(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="saml-entity-id">SP Entity ID</Label>
                <Input
                  id="saml-entity-id"
                  value={samlEntityId}
                  onChange={(e) => setSamlEntityId(e.target.value)}
                  placeholder="https://your-metis-url/sp"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="saml-acs-url">ACS URL</Label>
                <Input
                  id="saml-acs-url"
                  value={samlAcsUrl}
                  onChange={(e) => setSamlAcsUrl(e.target.value)}
                  placeholder="https://your-metis-url/api/auth/saml/acs"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="saml-metadata">IdP Metadata XML</Label>
                <Textarea
                  id="saml-metadata"
                  rows={8}
                  value={samlMetadata}
                  onChange={(e) => setSamlMetadata(e.target.value)}
                  placeholder={
                    samlMetadataConfigured
                      ? "IdP metadata is configured. Leave blank to keep it, or paste new XML to replace it."
                      : "Paste IdP metadata XML here..."
                  }
                />
                {samlMetadataConfigured && (
                  <p className="text-xs text-muted-foreground">
                    IdP metadata is stored. Leave blank to keep the existing configuration, or paste
                    new XML to replace it.
                  </p>
                )}
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="saml-enabled"
                  checked={samlEnabled}
                  onChange={(e) => setSamlEnabled(e.target.checked)}
                />
                <Label htmlFor="saml-enabled">Enable SAML Provider</Label>
              </div>
              <Button onClick={saveSAML} disabled={saving}>
                {saving ? "Saving…" : "Save SAML Configuration"}
              </Button>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="oidc">
          <Card>
            <CardHeader>
              <CardTitle>OIDC Configuration</CardTitle>
              <CardDescription>Configure OpenID Connect provider with PKCE.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="oidc-name">Provider Name</Label>
                <Input
                  id="oidc-name"
                  value={oidcName}
                  onChange={(e) => setOidcName(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="oidc-discovery">Discovery URL</Label>
                <Input
                  id="oidc-discovery"
                  value={oidcDiscoveryUrl}
                  onChange={(e) => setOidcDiscoveryUrl(e.target.value)}
                  placeholder="https://idp.example.com/.well-known/openid-configuration"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="oidc-client-id">Client ID</Label>
                <Input
                  id="oidc-client-id"
                  value={oidcClientId}
                  onChange={(e) => setOidcClientId(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="oidc-secret">Client Secret</Label>
                <Input
                  id="oidc-secret"
                  type="password"
                  value={oidcClientSecret}
                  onChange={(e) => setOidcClientSecret(e.target.value)}
                  placeholder={
                    oidcSecretConfigured
                      ? "••••••••  (leave blank to keep existing)"
                      : "Client secret"
                  }
                />
                {oidcSecretConfigured && (
                  <p className="text-xs text-muted-foreground">
                    A client secret is configured. Leave blank to keep it, or enter a new value to
                    replace it.
                  </p>
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="oidc-redirect">Redirect URI</Label>
                <Input
                  id="oidc-redirect"
                  value={oidcRedirectUri}
                  onChange={(e) => setOidcRedirectUri(e.target.value)}
                  placeholder="https://your-metis-url/api/auth/oidc/callback"
                />
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="oidc-enabled"
                  checked={oidcEnabled}
                  onChange={(e) => setOidcEnabled(e.target.checked)}
                />
                <Label htmlFor="oidc-enabled">Enable OIDC Provider</Label>
              </div>
              <Button onClick={saveOIDC} disabled={saving}>
                {saving ? "Saving…" : "Save OIDC Configuration"}
              </Button>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="scim">
          <Card>
            <CardHeader>
              <CardTitle>SCIM 2.0 Provisioning</CardTitle>
              <CardDescription>
                Manage SCIM bearer tokens for automated user/group provisioning.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">
                SCIM endpoints are available at <code>/api/scim/v2/Users</code> and{" "}
                <code>/api/scim/v2/Groups</code>. Use the bearer token below for authentication.
              </p>
              {scimToken && (
                <div className="rounded-md border bg-muted p-3">
                  <p className="text-xs text-muted-foreground mb-1">New SCIM Token (shown once):</p>
                  <code className="text-sm font-mono break-all">{scimToken}</code>
                </div>
              )}
              <Button onClick={rotateScimToken} variant="destructive">
                Rotate SCIM Token
              </Button>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="ldap">
          <Card>
            <CardHeader>
              <CardTitle>LDAP / Active Directory</CardTitle>
              <CardDescription>
                Configure direct authentication against an LDAP or Active Directory server. Users
                authenticate with their AD username and password via the standard login form.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {ldapConfigured && (
                <div className="rounded-md border border-green-200 bg-green-50 dark:border-green-800 dark:bg-green-950 px-3 py-2 text-sm text-green-700 dark:text-green-300">
                  LDAP is configured. Set <code>AUTH_MODE=ldap</code> to enable.
                </div>
              )}
              <div className="space-y-1.5">
                <Label htmlFor="ldap-url">LDAP URL</Label>
                <Input
                  id="ldap-url"
                  value={ldapUrl}
                  onChange={(e) => setLdapUrl(e.target.value)}
                  placeholder="ldaps://ad.example.com:636"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ldap-base-dn">Base DN</Label>
                <Input
                  id="ldap-base-dn"
                  value={ldapBaseDN}
                  onChange={(e) => setLdapBaseDN(e.target.value)}
                  placeholder="DC=ad,DC=example,DC=com"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ldap-bind-dn">Bind DN (Service Account)</Label>
                <Input
                  id="ldap-bind-dn"
                  value={ldapBindDN}
                  onChange={(e) => setLdapBindDN(e.target.value)}
                  placeholder="CN=svcaccount,OU=Service Accounts,DC=ad,DC=example,DC=com"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ldap-bind-pw">Bind Password</Label>
                <Input
                  id="ldap-bind-pw"
                  type="password"
                  value={ldapBindPassword}
                  onChange={(e) => setLdapBindPassword(e.target.value)}
                  placeholder={
                    ldapConfigured
                      ? "••••••••  (leave blank to keep existing)"
                      : "Service account password"
                  }
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ldap-user-search-base">User Search Base</Label>
                <Input
                  id="ldap-user-search-base"
                  value={ldapUserSearchBase}
                  onChange={(e) => setLdapUserSearchBase(e.target.value)}
                  placeholder="OU=Standard Users,DC=ad,DC=example,DC=com"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ldap-filter">Search Filter</Label>
                <Input
                  id="ldap-filter"
                  value={ldapSearchFilter}
                  onChange={(e) => setLdapSearchFilter(e.target.value)}
                  placeholder="(&(objectClass=user)(sAMAccountName={{username}}))"
                />
                <p className="text-xs text-muted-foreground">
                  Use <code>{"{{username}}"}</code> as a placeholder for the login username.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="ldap-tls-skip"
                  checked={ldapTlsSkipVerify}
                  onChange={(e) => setLdapTlsSkipVerify(e.target.checked)}
                />
                <Label htmlFor="ldap-tls-skip">
                  Skip TLS certificate verification (internal CA)
                </Label>
              </div>

              {ldapTestResult && (
                <div
                  className={`rounded-md border px-3 py-2 text-sm ${
                    ldapTestResult.startsWith("✓")
                      ? "border-green-200 bg-green-50 text-green-700 dark:border-green-800 dark:bg-green-950 dark:text-green-300"
                      : "border-red-200 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300"
                  }`}
                >
                  {ldapTestResult}
                </div>
              )}

              <div className="flex gap-2">
                <Button onClick={saveLDAP} disabled={saving}>
                  {saving ? "Saving…" : "Save LDAP Configuration"}
                </Button>
                <Button variant="outline" onClick={testLDAP}>
                  Test Connection
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="mappings">
          <Card>
            <CardHeader>
              <CardTitle>Group → Role Mappings</CardTitle>
              <CardDescription>
                Map IdP group claims to METIS roles. At least one mapping must resolve to admin.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="default-role">Default Role (when no mapping matches)</Label>
                <select
                  id="default-role"
                  value={defaultRole}
                  onChange={(e) => setDefaultRole(e.target.value)}
                  className="w-full rounded-md border px-3 py-2 text-sm"
                >
                  <option value="reader">Reader</option>
                  <option value="developer">Developer</option>
                  <option value="coordinator">Coordinator</option>
                  <option value="admin">Admin</option>
                </select>
              </div>

              <div className="space-y-2">
                {mappings.map((mapping, index) => (
                  <div key={index} className="flex gap-2 items-center">
                    <Input
                      placeholder="Group claim value"
                      value={mapping.claimValue}
                      onChange={(e) => updateMapping(index, "claimValue", e.target.value)}
                      className="flex-1"
                    />
                    <select
                      value={mapping.role}
                      onChange={(e) => updateMapping(index, "role", e.target.value)}
                      className="rounded-md border px-3 py-2 text-sm"
                    >
                      <option value="reader">Reader</option>
                      <option value="developer">Developer</option>
                      <option value="coordinator">Coordinator</option>
                      <option value="admin">Admin</option>
                    </select>
                    <Button variant="ghost" size="sm" onClick={() => removeMapping(index)}>
                      ✕
                    </Button>
                  </div>
                ))}
              </div>

              <Button variant="outline" onClick={addMapping}>
                + Add Mapping
              </Button>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
