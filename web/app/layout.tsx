import type { Metadata } from "next";
import { IBM_Plex_Sans, IBM_Plex_Mono } from "next/font/google";
import { Toaster } from "@/components/ui/sonner";
import "./globals.css";

/**
 * Plex rather than the usual Inter: it comes from technical documentation and
 * industrial systems, which is what this console is. The mono is load-bearing —
 * the tool-activity feed is a machine log and is set as one, against the
 * agent's prose in the sans.
 */
const plexSans = IBM_Plex_Sans({
  variable: "--font-plex-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

const plexMono = IBM_Plex_Mono({
  variable: "--font-plex-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
});

export const metadata: Metadata = {
  title: "BrowserPilot",
  description: "Watch and direct AI agents driving your business systems.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      // Dark by default: this is a console people leave open, often beside the
      // browser it is driving.
      className={`dark ${plexSans.variable} ${plexMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="bg-background text-foreground min-h-full">
        {children}
        <Toaster position="bottom-right" />
      </body>
    </html>
  );
}
