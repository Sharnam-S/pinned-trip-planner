import type { Metadata } from "next";
import { Poppins } from "next/font/google";
import "./globals.css";

// Poppins isn't a variable font — load the weight steps the CSS actually
// uses (in-between values like 650/750 resolve to the nearest loaded step).
const poppins = Poppins({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
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
    <html lang="en" className={poppins.variable}>
      <body>{children}</body>
    </html>
  );
}
