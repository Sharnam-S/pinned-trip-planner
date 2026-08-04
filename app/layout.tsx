import type { Metadata } from "next";
import { Inter } from "next/font/google";
import Analytics from "@/components/Analytics";
import SyncAgent from "@/components/SyncAgent";
import "./globals.css";

// Inter is a variable font — all weights (including 650/750) render exactly.
const inter = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
});

export const metadata: Metadata = {
  title: "Pinned — every place they raved about, on one map",
  description:
    "Paste travel videos, get every recommended spot pinned on a map — with links back to the exact moment it was mentioned.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={inter.variable}>
      <body>
        <Analytics />
        <SyncAgent />
        {children}
      </body>
    </html>
  );
}
