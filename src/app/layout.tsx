import type { Metadata, Viewport } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { DataProvider } from "@/components/providers/DataProvider";
import { InspectorProvider } from "@/components/providers/InspectorProvider";
import { AppShell } from "@/components/AppShell";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "ABWizard · Alabama Baseball", template: "%s · ABWizard" },
  description: "Hitter sequence, count, freeze and tunnel tendency intelligence for Alabama Baseball.",
};

export const viewport: Viewport = {
  themeColor: "#090d16",
  colorScheme: "dark",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable} dark`}>
      <body className="min-h-dvh bg-bg text-ink">
        <DataProvider>
          <InspectorProvider>
            <AppShell>{children}</AppShell>
          </InspectorProvider>
        </DataProvider>
      </body>
    </html>
  );
}
