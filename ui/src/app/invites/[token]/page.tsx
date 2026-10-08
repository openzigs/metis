"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { Building2, CheckCircle2, XCircle, Clock, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

interface InviteInfo {
  valid: boolean;
  expired: boolean;
  consumed: boolean;
  /** The workspace was deleted (#579). */
  workspaceDeleted?: boolean;
  /** Withheld (`null`) whenever `valid` is false — expired, used or deleted (#579, #597). */
  workspace: { id: string; name: string; slug: string } | null;
  /** Withheld (`null`) whenever `valid` is false (#579, #597). */
  invitedBy: string | null;
  /**
   * The invitee's address, role and expiry: also withheld (`null`) whenever `valid`
   * is false (#597). The invalid-invite cards read only the reason flags.
   */
  email: string | null;
  role: string | null;
  expiresAt: string | null;
}

export default function InviteAcceptPage() {
  const params = useParams<{ token: string }>();
  const router = useRouter();
  const [invite, setInvite] = useState<InviteInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [accepting, setAccepting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [accepted, setAccepted] = useState(false);

  useEffect(() => {
    async function fetchInvite() {
      try {
        const res = await fetch(`/api/workspaces/invites/${params.token}`);
        if (!res.ok) {
          const json = await res.json().catch(() => null);
          setError(json?.error?.message ?? "Invalid invitation link");
          return;
        }
        const json = await res.json();
        setInvite(json.data);
      } catch {
        setError("Failed to validate invitation");
      } finally {
        setLoading(false);
      }
    }
    fetchInvite();
  }, [params.token]);

  async function handleAccept() {
    setAccepting(true);
    setError(null);
    try {
      const res = await fetch(`/api/workspaces/invites/${params.token}/accept`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (res.status === 401) {
        // #941 — accepting needs a session as the invited email. Sign in, then
        // land back here to accept (the login form validates `next`).
        router.push(`/login?next=${encodeURIComponent(`/invites/${params.token}`)}`);
        return;
      }
      if (!res.ok) {
        const json = await res.json().catch(() => null);
        setError(json?.error?.message ?? "Failed to accept invitation");
        return;
      }
      setAccepted(true);
      // Redirect to dashboard after a short delay
      setTimeout(() => router.push("/dashboard"), 2000);
    } catch {
      setError("Network error — please try again");
    } finally {
      setAccepting(false);
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error && !invite) {
    return (
      <div className="flex min-h-screen items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <XCircle className="mx-auto h-12 w-12 text-destructive" />
            <CardTitle className="mt-3">Invalid Invitation</CardTitle>
            <CardDescription>{error}</CardDescription>
          </CardHeader>
          <CardContent className="text-center">
            <Button variant="outline" onClick={() => router.push("/")}>
              Go to homepage
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (accepted) {
    return (
      <div className="flex min-h-screen items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <CheckCircle2 className="mx-auto h-12 w-12 text-success" />
            <CardTitle className="mt-3">Welcome!</CardTitle>
            <CardDescription>
              You&apos;ve joined <strong>{invite?.workspace?.name}</strong>. Redirecting…
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  if (invite?.workspaceDeleted) {
    return (
      <div className="flex min-h-screen items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <XCircle className="mx-auto h-12 w-12 text-destructive" />
            <CardTitle className="mt-3">Workspace No Longer Exists</CardTitle>
            <CardDescription>
              The workspace this invitation was for has been deleted, so it can no longer be joined.
            </CardDescription>
          </CardHeader>
          <CardContent className="text-center">
            <Button variant="outline" onClick={() => router.push("/")}>
              Go to homepage
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (invite && !invite.valid) {
    return (
      <div className="flex min-h-screen items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <Clock className="mx-auto h-12 w-12 text-warning" />
            {/* Used before expired, as the accept route checks `consumedAt` first (#597).
                `consumedAt` is set by an accept *or* by a newer invite to the same email
                superseding this one, so the copy must not claim it was accepted. */}
            <CardTitle className="mt-3">
              {invite.consumed ? "Invitation No Longer Valid" : "Invitation Expired"}
            </CardTitle>
            <CardDescription>
              {invite.consumed
                ? "This invitation has already been used or replaced by a newer one. Please ask the workspace admin if you still need access."
                : "This invitation has expired. Please ask the workspace admin for a new one."}
            </CardDescription>
          </CardHeader>
          <CardContent className="text-center">
            <Button variant="outline" onClick={() => router.push("/")}>
              Go to homepage
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <Building2 className="mx-auto h-12 w-12 text-primary" />
          <CardTitle className="mt-3">Workspace Invitation</CardTitle>
          <CardDescription>
            <strong>{invite?.invitedBy}</strong> invited you to join
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-lg border bg-muted/50 p-4 text-center">
            <p className="text-lg font-semibold">{invite?.workspace?.name}</p>
            <p className="text-sm text-muted-foreground">
              Role: <span className="capitalize">{invite?.role}</span>
            </p>
          </div>
          <p className="text-center text-sm text-muted-foreground">
            Invitation for <strong>{invite?.email}</strong>. Sign in as this account to accept it.
          </p>
          {error && <p className="text-center text-sm text-destructive">{error}</p>}
          <Button className="w-full" size="lg" onClick={handleAccept} disabled={accepting}>
            {accepting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Accept invitation
          </Button>
          <p className="text-center text-xs text-muted-foreground">
            Expires: {invite?.expiresAt ? new Date(invite.expiresAt).toLocaleDateString() : "—"}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
