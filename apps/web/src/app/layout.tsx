import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "MyPropGuard Onchain",
  description: "Trading risk enforcement for Hyperliquid, powered by Ighodalo Labs.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
