import type { Metadata } from "next";
import Script from "next/script";
import "./globals.css";
import { Providers } from "@/components/providers";
import { RUNTIME_CONFIG_PATH } from "@/lib/socket-url";

export const metadata: Metadata = {
  title: "METIS",
  description:
    "METIS — Master Enterprise Tool for Issue Synthesis. Plan, analyze, and ship enterprise epics.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen antialiased">
        {/* #1377 — runtime settings (the Socket.IO URL) from the UI server's
            environment at request time, loaded before the app hydrates. */}
        <Script src={RUNTIME_CONFIG_PATH} strategy="beforeInteractive" />
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
