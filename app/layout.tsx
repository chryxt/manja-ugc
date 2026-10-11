import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "MANJA UGC",
  description: "AI UGC workspace for product content operations.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="id">
      <body>{children}</body>
    </html>
  );
}
