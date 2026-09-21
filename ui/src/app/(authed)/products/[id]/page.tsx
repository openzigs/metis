"use client";

/**
 * Product detail — view product, manage repos, view generated docs (Epic #544 / Issue #554).
 */
import { use, useState, useCallback } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "@/lib/api-client";
import {
  productsApi,
  parseContractDocMeta,
  type ProductDocument as ProductDocType,
  type RepoConnectionOption,
} from "@/lib/products-api";
import { queryKeys } from "@/lib/query-keys";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { MarkdownPreviewer } from "@/components/markdown-previewer";
import { ArrowLeft, Plus, Trash2, RefreshCw, FileText, Network, Server, Code2 } from "lucide-react";

const REPO_ROLES = [
  "frontend",
  "backend-api",
  "shared-library",
  "infrastructure",
  "docs",
  "gateway",
  "worker",
  "other",
];

type DocTab = "unified-architecture" | "per-service" | "api-contract";

export default function ProductDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const qc = useQueryClient();

  const product = useQuery({
    queryKey: queryKeys.products.detail(id),
    queryFn: () => productsApi.get(id),
  });

  const documents = useQuery({
    queryKey: queryKeys.products.documents(id),
    queryFn: () => productsApi.getDocuments(id),
  });

  const analyses = useQuery({
    queryKey: queryKeys.products.analyses(id),
    queryFn: () => productsApi.getAnalyses(id),
  });

  const [addRepoOpen, setAddRepoOpen] = useState(false);
  const [repoConnectionId, setRepoConnectionId] = useState("");
  const [repoRole, setRepoRole] = useState("backend-api");
  const [repoError, setRepoError] = useState<string | null>(null);
  const [repoSearch, setRepoSearch] = useState("");
  const [docTab, setDocTab] = useState<DocTab>("unified-architecture");
  const [selectedRepoDoc, setSelectedRepoDoc] = useState<string | null>(null);

  // Repo connections for picker
  const repoConnections = useQuery({
    queryKey: queryKeys.products.repoConnections(repoSearch),
    queryFn: () => productsApi.listRepoConnections(repoSearch || undefined),
    enabled: addRepoOpen,
  });

  const addRepo = useMutation({
    mutationFn: () => productsApi.addRepo(id, { repoConnectionId, role: repoRole }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.products.detail(id) });
      setAddRepoOpen(false);
      setRepoConnectionId("");
      setRepoRole("backend-api");
      setRepoError(null);
      setRepoSearch("");
    },
    onError: (err: unknown) => {
      setRepoError(err instanceof ApiError ? err.message : "Failed to add repo");
    },
  });

  const removeRepo = useMutation({
    mutationFn: (repoConnId: string) => productsApi.removeRepo(id, repoConnId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.products.detail(id) });
    },
  });

  const analyze = useMutation({
    mutationFn: () => productsApi.analyze(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.products.documents(id) });
      qc.invalidateQueries({ queryKey: queryKeys.products.analyses(id) });
    },
  });

  const handleAnalyze = useCallback(() => {
    analyze.mutate();
  }, [analyze]);

  if (product.isLoading) {
    return <div className="p-6 text-muted-foreground">Loading\u2026</div>;
  }

  if (!product.data) {
    return <div className="p-6 text-destructive">Product not found.</div>;
  }

  const p = product.data;

  // Group documents by type
  const docs = documents.data ?? [];
  const unifiedDocs = docs.filter((d) => d.docType === "unified-architecture");
  const perServiceDocs = docs.filter((d) => d.docType === "per-service");
  const apiContractDocs = docs.filter((d) => d.docType === "api-contract");

  // Latest analysis for freshness indicator
  const latestAnalysis = analyses.data?.[0];
  const lastGenerated = latestAnalysis?.completedAt ? new Date(latestAnalysis.completedAt) : null;

  // Currently selected doc content
  let activeDoc: ProductDocType | null = null;
  if (docTab === "unified-architecture") {
    activeDoc = unifiedDocs[0] ?? null;
  } else if (docTab === "per-service") {
    activeDoc = selectedRepoDoc
      ? (perServiceDocs.find((d) => d.repoId === selectedRepoDoc) ?? perServiceDocs[0] ?? null)
      : (perServiceDocs[0] ?? null);
  } else if (docTab === "api-contract") {
    activeDoc = selectedRepoDoc
      ? (apiContractDocs.find((d) => d.repoId === selectedRepoDoc) ?? apiContractDocs[0] ?? null)
      : (apiContractDocs[0] ?? null);
  }

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center gap-4">
        <Link href="/products">
          <Button variant="ghost" size="icon" aria-label="Back to products">
            <ArrowLeft className="h-4 w-4" aria-hidden />
          </Button>
        </Link>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{p.name}</h1>
          <p className="text-sm text-muted-foreground">{p.description || "No description"}</p>
        </div>
      </div>

      {/* Repositories section */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-medium">Repositories</h2>
          <Dialog open={addRepoOpen} onOpenChange={setAddRepoOpen}>
            <DialogTrigger asChild>
              <Button size="sm" variant="outline" data-testid="add-repo-button">
                <Plus className="h-4 w-4 mr-1" /> Add Repo
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Add repository to product</DialogTitle>
              </DialogHeader>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  addRepo.mutate();
                }}
                className="space-y-4"
              >
                <div className="space-y-2">
                  <Label htmlFor="repo-search">Repository Connection</Label>
                  <Input
                    id="repo-search"
                    value={repoSearch}
                    onChange={(e) => setRepoSearch(e.target.value)}
                    placeholder="Search repo connections\u2026"
                  />
                  <div className="max-h-48 overflow-y-auto rounded-md border">
                    {repoConnections.isLoading && (
                      <p className="p-2 text-sm text-muted-foreground">Loading\u2026</p>
                    )}
                    {repoConnections.data && repoConnections.data.length === 0 && (
                      <p className="p-2 text-sm text-muted-foreground">No connections found.</p>
                    )}
                    {repoConnections.data?.map((conn: RepoConnectionOption) => (
                      <button
                        type="button"
                        key={conn.id}
                        onClick={() => {
                          setRepoConnectionId(conn.id);
                          setRepoSearch(`${conn.ownerOrOrg}/${conn.repoName}`);
                        }}
                        className={`w-full text-left px-3 py-2 text-sm hover:bg-accent transition-colors ${
                          repoConnectionId === conn.id ? "bg-accent font-medium" : ""
                        }`}
                      >
                        <span className="font-medium">
                          {conn.ownerOrOrg}/{conn.repoName}
                        </span>
                        <span className="text-muted-foreground ml-2">({conn.label})</span>
                      </button>
                    ))}
                  </div>
                  {repoConnectionId && (
                    <p className="text-xs text-muted-foreground">
                      Selected: <code>{repoConnectionId}</code>
                    </p>
                  )}
                </div>
                <div className="space-y-2">
                  <Label htmlFor="repo-role">Role</Label>
                  <select
                    id="repo-role"
                    value={repoRole}
                    onChange={(e) => setRepoRole(e.target.value)}
                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    {REPO_ROLES.map((role) => (
                      <option key={role} value={role}>
                        {role}
                      </option>
                    ))}
                  </select>
                </div>
                {repoError && <p className="text-sm text-destructive">{repoError}</p>}
                <Button
                  type="submit"
                  disabled={addRepo.isPending || !repoConnectionId}
                  className="w-full"
                >
                  {addRepo.isPending ? "Adding\u2026" : "Add Repository"}
                </Button>
              </form>
            </DialogContent>
          </Dialog>
        </div>

        {(!p.repos || p.repos.length === 0) && (
          <Card className="p-6 text-center">
            <p className="text-muted-foreground">
              No repositories associated yet. Add repositories to enable cross-repo analysis.
            </p>
          </Card>
        )}

        {p.repos && p.repos.length > 0 && (
          <div className="space-y-2">
            {p.repos.map((repo) => (
              <Card key={repo.id} className="p-4 flex items-center justify-between">
                <div>
                  <p className="font-medium">
                    {repo.repoConnection
                      ? `${repo.repoConnection.ownerOrOrg}/${repo.repoConnection.repoName}`
                      : repo.repoConnectionId}
                  </p>
                  <p className="text-sm text-muted-foreground">Role: {repo.role}</p>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => removeRepo.mutate(repo.repoConnectionId)}
                  disabled={removeRepo.isPending}
                  aria-label="Remove repository"
                >
                  <Trash2 className="h-4 w-4 text-destructive" aria-hidden />
                </Button>
              </Card>
            ))}
          </div>
        )}
      </section>

      {/* Documentation section */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-medium">Documentation</h2>
          <div className="flex items-center gap-3">
            {lastGenerated && (
              <span className="text-xs text-muted-foreground">
                Last generated: {lastGenerated.toLocaleString()}
              </span>
            )}
            <Button
              size="sm"
              variant="outline"
              onClick={handleAnalyze}
              disabled={analyze.isPending || !p.repos || p.repos.length === 0}
              data-testid="generate-docs-button"
            >
              <RefreshCw className={`h-4 w-4 mr-1 ${analyze.isPending ? "animate-spin" : ""}`} />
              {analyze.isPending ? "Generating\u2026" : "Generate Documentation"}
            </Button>
          </div>
        </div>

        {analyze.isSuccess && (
          <div className="rounded-md border border-green-200 bg-green-50 dark:border-green-800 dark:bg-green-950 p-3">
            <p className="text-sm text-green-700 dark:text-green-300">
              Documentation generated successfully.
            </p>
          </div>
        )}

        {analyze.isError && (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3">
            <p className="text-sm text-destructive">
              {analyze.error instanceof ApiError
                ? analyze.error.message
                : "Failed to generate documentation."}
            </p>
          </div>
        )}

        {documents.isLoading && (
          <Card className="p-6 text-center">
            <p className="text-muted-foreground">Loading documentation\u2026</p>
          </Card>
        )}

        {!documents.isLoading && docs.length === 0 && (
          <Card className="p-6 text-center">
            <p className="text-muted-foreground">
              No documentation generated yet. Add repositories and click &quot;Generate
              Documentation&quot; to start.
            </p>
          </Card>
        )}

        {docs.length > 0 && (
          <div className="flex gap-4">
            {/* Sidebar navigation */}
            <nav className="w-56 shrink-0 space-y-1">
              <button
                onClick={() => {
                  setDocTab("unified-architecture");
                  setSelectedRepoDoc(null);
                }}
                className={`w-full flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors ${
                  docTab === "unified-architecture" ? "bg-accent font-medium" : "hover:bg-accent/50"
                }`}
              >
                <Network className="h-4 w-4" />
                Unified Architecture
              </button>

              <div className="pt-2">
                <p className="px-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Per-Service
                </p>
                {perServiceDocs.map((doc) => (
                  <button
                    key={doc.id}
                    onClick={() => {
                      setDocTab("per-service");
                      setSelectedRepoDoc(doc.repoId);
                    }}
                    className={`w-full flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors ${
                      docTab === "per-service" && selectedRepoDoc === doc.repoId
                        ? "bg-accent font-medium"
                        : "hover:bg-accent/50"
                    }`}
                  >
                    <Server className="h-4 w-4" />
                    <span className="truncate">
                      {doc.title.replace(/ \u2014 Service Documentation$/, "")}
                    </span>
                  </button>
                ))}
                {perServiceDocs.length === 0 && (
                  <p className="px-3 py-1 text-xs text-muted-foreground">None</p>
                )}
              </div>

              <div className="pt-2">
                <p className="px-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  API Contracts
                </p>
                {apiContractDocs.map((doc) => (
                  <button
                    key={doc.id}
                    onClick={() => {
                      setDocTab("api-contract");
                      setSelectedRepoDoc(doc.repoId);
                    }}
                    className={`w-full flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors ${
                      docTab === "api-contract" && selectedRepoDoc === doc.repoId
                        ? "bg-accent font-medium"
                        : "hover:bg-accent/50"
                    }`}
                  >
                    <Code2 className="h-4 w-4" />
                    <span className="truncate">
                      {doc.title.replace(/ \u2014 API Contracts$/, "")}
                    </span>
                    {parseContractDocMeta(doc)?.hasContractChanges && (
                      <Badge
                        variant="secondary"
                        className="ml-auto shrink-0 text-[10px]"
                        title="Contract changed since the previous version"
                      >
                        diff
                      </Badge>
                    )}
                  </button>
                ))}
                {apiContractDocs.length === 0 && (
                  <p className="px-3 py-1 text-xs text-muted-foreground">None</p>
                )}
              </div>
            </nav>

            {/* Document content */}
            <div className="flex-1 min-w-0">
              {activeDoc ? (
                <Card className="p-6">
                  <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-2">
                      <FileText className="h-4 w-4 text-muted-foreground" />
                      <h3 className="font-medium">{activeDoc.title}</h3>
                      {(() => {
                        const meta =
                          activeDoc.docType === "api-contract"
                            ? parseContractDocMeta(activeDoc)
                            : null;
                        return meta?.hasContractChanges ? (
                          <Badge variant="secondary" title={meta.diffSummary}>
                            {meta.diffSummary}
                          </Badge>
                        ) : null;
                      })()}
                    </div>
                    <span className="text-xs text-muted-foreground">
                      v{activeDoc.version} &bull; {new Date(activeDoc.generatedAt).toLocaleString()}
                    </span>
                  </div>
                  <MarkdownPreviewer content={activeDoc.content} showToc={false} />
                </Card>
              ) : (
                <Card className="p-6 text-center">
                  <p className="text-muted-foreground">Select a document from the sidebar.</p>
                </Card>
              )}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
