"use client";

import { useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { UserPlus, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ApiError, apiFetch } from "@/lib/api-client";

/** What `POST /api/workspaces/:id/invites` returns (#765). */
interface CreatedInvite {
  id: string;
  email: string;
  expiresAt: string;
  token: string;
}

/** #941 — owners and admins may invite (mirrors the server's `requireWorkspaceRole("admin")`). */
export function canInviteMembers(
  members: readonly { role: string; user: { id: string } }[],
  userId: string | undefined,
): boolean {
  if (!userId) return false;
  const role = members.find((m) => m.user.id === userId)?.role;
  return role === "owner" || role === "admin";
}

/**
 * #941 — invite a member to a workspace. Rendered for owners and admins only;
 * the server enforces the same rule (`requireWorkspaceRole("admin")`).
 *
 * No invitation email is sent yet, so the card shows the invite link for the
 * inviter to share. The link alone does not grant access: accepting it needs
 * a session as the invited address.
 */
export function InviteMemberCard({ workspaceId }: { workspaceId: string }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"member" | "admin">("member");
  const [copied, setCopied] = useState(false);

  const invite = useMutation({
    mutationFn: (body: { email: string; role: "member" | "admin" }) =>
      apiFetch<CreatedInvite>(`/workspaces/${workspaceId}/invites`, {
        method: "POST",
        body,
      }),
    onSuccess: () => {
      setEmail("");
      setCopied(false);
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    invite.mutate({ email: email.trim(), role });
  }

  const created = invite.data;
  const link = created ? `${window.location.origin}/invites/${created.token}` : null;

  async function copyLink() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Invite a member</CardTitle>
        <CardDescription>
          Create an invite link for an email address. The invitee must sign in as that address to
          accept it.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
          <div className="min-w-[14rem] flex-1 space-y-2">
            <Label htmlFor="invite-email">Email</Label>
            <Input
              id="invite-email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="reviewer@example.com"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="invite-role">Role</Label>
            <select
              id="invite-role"
              value={role}
              onChange={(e) => setRole(e.target.value as "member" | "admin")}
              className="h-9 rounded-md border bg-background px-2 text-sm"
            >
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </select>
          </div>
          <Button type="submit" disabled={invite.isPending || email.trim() === ""}>
            <UserPlus className="mr-1.5 h-4 w-4" />
            Create invite
          </Button>
        </form>

        {invite.isError && (
          <p role="alert" className="text-sm text-destructive">
            {invite.error instanceof ApiError ? invite.error.message : "Failed to create invite"}
          </p>
        )}

        {created && link && (
          <div className="space-y-2 rounded-md border bg-muted/50 p-3 text-sm">
            <p>
              Invite created for <strong>{created.email}</strong>. Share this link with them; it
              expires {new Date(created.expiresAt).toLocaleDateString()}.
            </p>
            <div className="flex items-center gap-2">
              <Input readOnly aria-label="Invite link" value={link} className="font-mono text-xs" />
              <Button type="button" variant="outline" size="sm" onClick={copyLink}>
                <Copy className="mr-1.5 h-4 w-4" />
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
