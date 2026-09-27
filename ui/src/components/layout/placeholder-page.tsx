import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";

interface PlaceholderProps {
  title: string;
  description: string;
}

/**
 * Lightweight stub used by every Phase-3 route until that surface ships in
 * its own phase. Keeps the shell demo-able and gives Cypress / RTL a stable
 * landmark to assert against.
 */
export function PlaceholderPage({ title, description }: PlaceholderProps) {
  return (
    <section aria-labelledby="page-title" className="space-y-4">
      <PageHeader title={title} titleId="page-title" description={description} />
      <Card>
        <CardHeader>
          <CardTitle>Coming soon</CardTitle>
          <CardDescription>
            This surface is reserved for a later phase. The shell, navigation, and auth boundary are
            wired in Phase 3.
          </CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Track progress in the Phase-3 epic and its sub-issues.
        </CardContent>
      </Card>
    </section>
  );
}
