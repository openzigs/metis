import Link from "next/link";
import { PlaceholderPage } from "@/components/layout/placeholder-page";

export default function AdminPage() {
  return (
    <div className="space-y-6 p-6">
      <PlaceholderPage
        title="Admin"
        description="Workspaces, SSO & authentication, MCP servers, skills, agents, embeddings, and usage."
      />
      <div className="space-y-2">
        <h2 className="text-lg font-semibold">Sections</h2>
        <ul className="list-disc pl-5 text-sm">
          <li>
            <Link href="/admin/workspaces" className="underline">
              Workspaces
            </Link>{" "}
            — create and manage organization workspaces, members, and project assignments.
          </li>
          <li>
            <Link href="/admin/auth" className="underline">
              SSO &amp; Authentication
            </Link>{" "}
            — configure SAML, OIDC, SCIM, and group-to-role mappings.
          </li>
          <li>
            <Link href="/admin/mcp" className="underline">
              MCP servers
            </Link>{" "}
            — register and monitor MCP integrations.
          </li>
          <li>
            <Link href="/admin/skills" className="underline">
              Skills library
            </Link>{" "}
            — author and version reusable instruction blocks.
          </li>
          <li>
            <Link href="/admin/agents" className="underline">
              Agents library
            </Link>{" "}
            — define personas with default skills and tool restrictions.
          </li>
          <li>
            <Link href="/admin/embeddings" className="underline">
              Embedding backends
            </Link>{" "}
            — select the RAG embedding backend and reindex projects after a dimension change.
          </li>
          <li>
            <Link href="/admin/usage" className="underline">
              Usage
            </Link>{" "}
            — platform usage metrics and activity reporting.
          </li>
        </ul>
      </div>
    </div>
  );
}
