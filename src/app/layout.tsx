import type { Metadata } from "next";
import { QueryProvider } from "@/providers/query-provider";
import "./globals.css";

export const metadata: Metadata = {
  title: "OpsPilot - AI Operations Copilot for Logistics",
  description: "Intelligent AI operations copilot for real-time logistics tracking, fleet optimization, and decision automation.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased selection:bg-blue-500 selection:text-white">
        <QueryProvider>{children}</QueryProvider>
      </body>
    </html>
  );
}
