/**
 * #1377 — the runtime socket override reaches the browser only because the root
 * layout loads `/runtime-config` before hydration. `socket-url.test.ts` sets the
 * global by hand, so it cannot see the layout losing that script; this can.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const scriptProps: Array<Record<string, unknown>> = [];

vi.mock("next/script", () => ({
  default: (props: Record<string, unknown>) => {
    scriptProps.push(props);
    return null;
  },
}));
vi.mock("@/components/providers", () => ({
  Providers: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@/app/globals.css", () => ({}));

import RootLayout from "@/app/layout";
import { RUNTIME_CONFIG_PATH } from "@/lib/socket-url";

describe("root layout (#1377)", () => {
  it("loads /runtime-config before the app hydrates", () => {
    renderToStaticMarkup(
      <RootLayout>
        <p>page</p>
      </RootLayout>,
    );
    expect(RUNTIME_CONFIG_PATH).toBe("/runtime-config");
    expect(scriptProps).toContainEqual(
      expect.objectContaining({ src: RUNTIME_CONFIG_PATH, strategy: "beforeInteractive" }),
    );
  });
});
