import type { Metadata, Viewport } from "next";
import { Space_Grotesk, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";
import { NavBar } from "@/components/nav-bar";

const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap"
});

const jetBrains = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap"
});

export const metadata: Metadata = {
  title: "OpenZigs Control Panel",
  description: "Monitor tools, approvals, and activity in OpenZigs.",
  icons: {
    icon: "/openzigs-icon.png",
    apple: "/openzigs-icon.png"
  }
};

export const viewport: Viewport = {
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${spaceGrotesk.variable} ${jetBrains.variable} grid h-dvh overflow-hidden antialiased`}
        style={{ gridTemplateRows: "auto 1fr" }}
      >
        <Providers>
          <NavBar />
          <div className="flex min-h-0 flex-col overflow-y-auto">{children}</div>
          <footer className="border-t border-border bg-background/80 text-center text-xs py-2 text-muted-foreground">
            © Zylos Labs LLC
          </footer>
        </Providers>
      </body>
    </html>
  );
}
