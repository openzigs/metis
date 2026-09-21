/**
 * Epic #196 / #220 — Settings sub-page: Profile.
 *
 * Renders profile-related controls only (display name, role, username view).
 * Lives under `/settings/profile`. The settings hub (`/settings`) becomes a
 * navigation index that links here.
 */
"use client";

import { Card } from "@/components/ui/card";
import { useAuth } from "@/lib/auth-context";

export default function SettingsProfilePage() {
  const { user } = useAuth();
  return (
    <div className="space-y-6 p-2 md:p-0" data-testid="settings-profile-root">
      <header>
        <h1 className="text-2xl font-semibold">Profile</h1>
        <p className="text-sm text-muted-foreground">
          Your account information. Username and role are managed by an administrator.
        </p>
      </header>
      <Card className="space-y-3 p-4" data-testid="settings-profile-card">
        <Field label="Username" value={user?.username ?? "—"} testId="settings-profile-username" />
        <Field
          label="Display name"
          value={user?.displayName ?? user?.username ?? "—"}
          testId="settings-profile-display-name"
        />
        <Field label="Email" value={user?.email ?? "—"} testId="settings-profile-email" />
        <Field label="Role" value={user?.role ?? "—"} testId="settings-profile-role" />
      </Card>
    </div>
  );
}

function Field({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <div className="grid grid-cols-3 gap-2 text-sm" data-testid={testId}>
      <span className="text-muted-foreground">{label}</span>
      <span className="col-span-2 font-medium">{value}</span>
    </div>
  );
}
