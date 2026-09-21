"use client";

/**
 * Database Connector Wizard — Epic #701 / Issue #705.
 *
 * Four-step wizard for promoting a discovered/suggested database connection
 * into a real, vault-backed DB connector:
 *   1) Review   — what was discovered, source file/line, confidence.
 *   2) Configure — driver/host/port/db/user/password (eye-toggle, vault-backed).
 *   3) Test      — credential-explicit liveness probe; must pass to proceed.
 *   4) Provision — creates vault secret + db connector atomically.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Eye, EyeOff, Loader2, ShieldCheck, CheckCircle2, XCircle } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  suggestedConnectorsApi,
  type SuggestedConnector,
  type SuggestedConnectorDetail,
  type SuggestedConnectorTestResult,
} from "@/lib/connectors-api";

const DRIVER_MAP: Record<string, string> = {
  postgresql: "postgres",
  postgres: "postgres",
  mysql: "mysql",
  oracle: "oracle",
  sqlserver: "sqlserver",
  sqlite: "sqlite",
};

type Step = "review" | "configure" | "test" | "provision";
const STEP_ORDER: Step[] = ["review", "configure", "test", "provision"];

export interface DbConnectorWizardProps {
  projectId: string;
  suggestion: SuggestedConnector;
  open: boolean;
  onOpenChange(open: boolean): void;
  onProvisioned?(connectorId: string): void;
}

function Steps({ current }: { current: Step }) {
  const idx = STEP_ORDER.indexOf(current);
  return (
    <ol className="flex items-center gap-2 text-xs">
      {STEP_ORDER.map((s, i) => (
        <li key={s} className="flex items-center gap-2">
          <span
            data-testid={`wizard-step-${s}`}
            className={
              "rounded-full px-2 py-0.5 " +
              (i < idx
                ? "bg-emerald-700/40 text-emerald-200"
                : i === idx
                  ? "bg-sky-700/60 text-sky-100"
                  : "bg-zinc-800 text-zinc-400")
            }
          >
            {i + 1}. {s}
          </span>
          {i < STEP_ORDER.length - 1 ? <span className="text-zinc-600">›</span> : null}
        </li>
      ))}
    </ol>
  );
}

export function DbConnectorWizard({
  projectId,
  suggestion,
  open,
  onOpenChange,
  onProvisioned,
}: DbConnectorWizardProps) {
  const [step, setStep] = useState<Step>("review");
  const [detail, setDetail] = useState<SuggestedConnectorDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [label, setLabel] = useState("");
  const [driver, setDriver] = useState("postgres");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("");
  const [database, setDatabase] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [testResult, setTestResult] = useState<SuggestedConnectorTestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [provisioning, setProvisioning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load detail (with one-shot password) the first time the wizard opens.
  useEffect(() => {
    if (!open || detail) return;
    setLoadingDetail(true);
    suggestedConnectorsApi
      .get(projectId, suggestion.id)
      .then((d) => {
        setDetail(d);
        setDriver(DRIVER_MAP[d.driverType] ?? "postgres");
        setHost(d.host ?? "");
        setPort(d.port ? String(d.port) : "");
        setDatabase(d.database ?? "");
        setUsername(d.username ?? "");
        setPassword(d.password ?? "");
        setLabel(`${d.driverType}-${d.database ?? "db"}`);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Failed to load suggestion");
      })
      .finally(() => setLoadingDetail(false));
  }, [open, detail, projectId, suggestion.id]);

  // Reset state when fully closed.
  useEffect(() => {
    if (open) return;
    setStep("review");
    setDetail(null);
    setLabel("");
    setDriver("postgres");
    setHost("");
    setPort("");
    setDatabase("");
    setUsername("");
    setPassword("");
    setTestResult(null);
    setError(null);
    setShowPassword(false);
  }, [open]);

  const canTest = useMemo(
    () => host.trim().length > 0 && database.trim().length > 0,
    [host, database],
  );

  const onTest = useCallback(async () => {
    setTesting(true);
    setError(null);
    try {
      const result = await suggestedConnectorsApi.test(projectId, suggestion.id, {
        host: host.trim(),
        port: port ? Number(port) : null,
        database: database.trim(),
        username: username.trim() || null,
        password: password || null,
      });
      setTestResult(result);
      if (result.ok) setStep("provision");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Test failed");
      setTestResult({ ok: false, errorMessage: "Network error" });
    } finally {
      setTesting(false);
    }
  }, [projectId, suggestion.id, host, port, database, username, password]);

  const onProvision = useCallback(async () => {
    setProvisioning(true);
    setError(null);
    try {
      const result = await suggestedConnectorsApi.provision(projectId, suggestion.id, {
        label: label.trim(),
        driver,
        host: host.trim() || null,
        port: port ? Number(port) : null,
        database: database.trim() || null,
        username: username.trim() || null,
        password,
      });
      onProvisioned?.(result.connectorId);
      onOpenChange(false);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Provision failed");
    } finally {
      setProvisioning(false);
    }
  }, [
    projectId,
    suggestion.id,
    label,
    driver,
    host,
    port,
    database,
    username,
    password,
    onProvisioned,
    onOpenChange,
  ]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl" onInteractOutside={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4" />
            Configure database connector
          </DialogTitle>
        </DialogHeader>

        <Steps current={step} />

        {error ? (
          <div
            role="alert"
            className="rounded border border-red-600/40 bg-red-950/30 p-2 text-sm text-red-200"
          >
            {error}
          </div>
        ) : null}

        {step === "review" ? (
          <section className="space-y-2 text-sm" data-testid="wizard-review">
            <p className="text-muted-foreground">
              We found this connection in your repository code. Review the details before
              configuring.
            </p>
            <dl className="grid grid-cols-3 gap-2 font-mono text-xs">
              <dt className="text-zinc-400">Driver</dt>
              <dd className="col-span-2">{suggestion.driverType}</dd>
              <dt className="text-zinc-400">Host:Port</dt>
              <dd className="col-span-2">
                {suggestion.host ?? "—"}
                {suggestion.port ? `:${suggestion.port}` : ""}
              </dd>
              <dt className="text-zinc-400">Database</dt>
              <dd className="col-span-2">{suggestion.database ?? "—"}</dd>
              <dt className="text-zinc-400">Source</dt>
              <dd className="col-span-2 truncate" title={suggestion.sourceFile}>
                {suggestion.sourceFile}:{suggestion.lineNumber}
              </dd>
              <dt className="text-zinc-400">Confidence</dt>
              <dd className="col-span-2">
                <Badge variant="outline">{suggestion.confidence}</Badge>
              </dd>
              {suggestion.devCredsDetected ? (
                <>
                  <dt className="text-zinc-400">Credentials</dt>
                  <dd className="col-span-2 flex items-center gap-1 text-emerald-400">
                    <ShieldCheck className="h-3 w-3" /> Dev credentials found in source — pre-loaded
                    from the vault.
                  </dd>
                </>
              ) : null}
            </dl>
          </section>
        ) : null}

        {step === "configure" ? (
          <section className="space-y-3 text-sm" data-testid="wizard-configure">
            {loadingDetail ? (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading credentials…
              </div>
            ) : null}
            <div>
              <Label htmlFor="wiz-label">Label</Label>
              <Input id="wiz-label" value={label} onChange={(e) => setLabel(e.target.value)} />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label htmlFor="wiz-driver">Driver</Label>
                <Select value={driver} onValueChange={setDriver}>
                  <SelectTrigger id="wiz-driver" className="mt-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="postgres">postgres</SelectItem>
                    <SelectItem value="mysql">mysql</SelectItem>
                    <SelectItem value="oracle">oracle</SelectItem>
                    <SelectItem value="sqlserver">sqlserver</SelectItem>
                    <SelectItem value="sqlite">sqlite</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label htmlFor="wiz-host">Host</Label>
                <Input id="wiz-host" value={host} onChange={(e) => setHost(e.target.value)} />
              </div>
              <div>
                <Label htmlFor="wiz-port">Port</Label>
                <Input id="wiz-port" value={port} onChange={(e) => setPort(e.target.value)} />
              </div>
              <div>
                <Label htmlFor="wiz-database">Database</Label>
                <Input
                  id="wiz-database"
                  value={database}
                  onChange={(e) => setDatabase(e.target.value)}
                />
              </div>
              <div>
                <Label htmlFor="wiz-username">Username</Label>
                <Input
                  id="wiz-username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                />
              </div>
              <div>
                <Label htmlFor="wiz-password">Password</Label>
                <div className="relative">
                  <Input
                    id="wiz-password"
                    type={showPassword ? "text" : "password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                  <button
                    type="button"
                    aria-label={showPassword ? "Hide password" : "Show password"}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-200"
                    onClick={() => setShowPassword((v) => !v)}
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>
            </div>
          </section>
        ) : null}

        {step === "test" ? (
          <section className="space-y-2 text-sm" data-testid="wizard-test">
            <p className="text-muted-foreground">
              Run a liveness probe to confirm credentials and network reachability before
              provisioning.
            </p>
            {testResult ? (
              testResult.ok ? (
                <div className="flex items-center gap-2 text-emerald-400">
                  <CheckCircle2 className="h-4 w-4" /> Connection successful ({testResult.latencyMs}
                  ms).
                </div>
              ) : (
                <div className="flex items-center gap-2 text-red-400">
                  <XCircle className="h-4 w-4" />
                  {testResult.errorMessage ?? testResult.errorCode ?? "Test failed."}
                </div>
              )
            ) : null}
          </section>
        ) : null}

        {step === "provision" ? (
          <section className="space-y-2 text-sm" data-testid="wizard-provision">
            <p className="text-muted-foreground">
              The test succeeded. Click <strong>Provision</strong> to create a vault-backed
              connector.
            </p>
            <ul className="list-disc pl-5 text-xs text-zinc-400">
              <li>
                Password will be stored in vault as{" "}
                <code>
                  provisioned-cred:project:{projectId}:suggestion:{suggestion.id}
                </code>
                .
              </li>
              <li>If creation fails, the vault entry is rolled back.</li>
            </ul>
          </section>
        ) : null}

        <footer className="mt-2 flex justify-between gap-2">
          <Button
            variant="ghost"
            onClick={() => {
              const idx = STEP_ORDER.indexOf(step);
              if (idx > 0) setStep(STEP_ORDER[idx - 1]);
              else onOpenChange(false);
            }}
            disabled={testing || provisioning}
          >
            {step === "review" ? "Cancel" : "Back"}
          </Button>
          {step === "review" ? (
            <Button onClick={() => setStep("configure")} disabled={loadingDetail}>
              Next
            </Button>
          ) : null}
          {step === "configure" ? (
            <Button onClick={() => setStep("test")} disabled={!canTest || loadingDetail}>
              Next
            </Button>
          ) : null}
          {step === "test" ? (
            <Button onClick={onTest} disabled={testing || !canTest}>
              {testing ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Testing…
                </>
              ) : (
                "Run test"
              )}
            </Button>
          ) : null}
          {step === "provision" ? (
            <Button onClick={onProvision} disabled={provisioning || !label.trim()}>
              {provisioning ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Provisioning…
                </>
              ) : (
                "Provision"
              )}
            </Button>
          ) : null}
        </footer>
      </DialogContent>
    </Dialog>
  );
}
