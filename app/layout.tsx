import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Async by Design — M-Pesa demo",
  description:
    "RenderCon Kenya demo: cloud infrastructure patterns for React apps that talk to M-Pesa.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      {/*
        System font stack on purpose, not an oversight: no external font
        fetch means nothing here depends on venue wifi being fast at the
        exact second you're on stage.
      */}
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
