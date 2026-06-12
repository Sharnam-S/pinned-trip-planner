import type { Metadata } from "next";
import "./globals.css";

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
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
