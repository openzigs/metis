/**
 * Epic #196 / #220 — Settings sub-page: Appearance.
 *
 * Theme + UI density controls. Lives under `/settings/appearance`.
 */
"use client";

import { useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/layout/theme-toggle";

const DENSITY_KEY = "metis.settings.density";
type Density = "compact" | "comfortable";

function readDensity(): Density {
  if (typeof window === "undefined") return "comfortable";
  const v = window.localStorage.getItem(DENSITY_KEY);
  return v === "compact" ? "compact" : "comfortable";
}

export default function SettingsAppearancePage() {
  const [density, setDensity] = useState<Density>(() => readDensity());
  const [savedToast, setSavedToast] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setSavedToast(false), 1500);
    return () => clearTimeout(t);
  }, [savedToast]);

  function persist(next: Density) {
    setDensity(next);
    window.localStorage.setItem(DENSITY_KEY, next);
    setSavedToast(true);
  }

  return (
    <div className="space-y-6 p-2 md:p-0" data-testid="settings-appearance-root">
      <header>
        <h1 className="text-2xl font-semibold">Appearance</h1>
        <p className="text-sm text-muted-foreground">
          Theme and UI density. Theme is mirrored in the header for quick access.
        </p>
      </header>
      <Card className="space-y-3 p-4" data-testid="settings-appearance-theme">
        <h2 className="text-sm font-semibold">Theme</h2>
        <p className="text-xs text-muted-foreground">Light, dark, or follow system.</p>
        <ThemeToggle />
      </Card>
      <Card className="space-y-3 p-4" data-testid="settings-appearance-density">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">UI density</h2>
          {savedToast ? (
            <span
              role="status"
              aria-live="polite"
              className="rounded bg-emerald-100 px-2 py-1 text-xs text-emerald-900"
              data-testid="settings-appearance-saved"
            >
              Saved
            </span>
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground">
          Comfortable spacing matches the default; compact reduces padding for information-dense
          screens.
        </p>
        <div className="flex gap-2">
          <Button
            variant={density === "comfortable" ? "default" : "outline"}
            onClick={() => persist("comfortable")}
            data-testid="settings-appearance-density-comfortable"
          >
            Comfortable
          </Button>
          <Button
            variant={density === "compact" ? "default" : "outline"}
            onClick={() => persist("compact")}
            data-testid="settings-appearance-density-compact"
          >
            Compact
          </Button>
        </div>
      </Card>
    </div>
  );
}
