import type { Metadata, Viewport } from "next";
import { Plus_Jakarta_Sans, Space_Grotesk } from "next/font/google";
import { QueryProvider } from "@/providers/query-provider";
import { OperationsNav } from "./_components/OperationsNav";
import "./globals.css";

export const metadata: Metadata = {
  title: "OpsPilot | Giao Hàng Nặng",
  description: "Điều hành incident, khuyến nghị AI, human review và follow-up trên một Operations Control Center.",
  applicationName: "OpsPilot",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "OpsPilot" },
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover", themeColor: "#000000" };
const jakarta = Plus_Jakarta_Sans({ subsets: ["latin", "vietnamese"], variable: "--font-jakarta", display: "swap" });
const spaceGrotesk = Space_Grotesk({ subsets: ["latin", "vietnamese"], variable: "--font-space", display: "swap" });

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="vi">
      <body className={`${jakarta.variable} ${spaceGrotesk.variable} antialiased selection:bg-teal-500 selection:text-black`}>
        <a href="#main-content" className="sr-only z-[100] rounded bg-teal-600 px-4 py-2 text-white focus:not-sr-only focus:fixed focus:left-4 focus:top-4">Bỏ qua điều hướng</a>
        <QueryProvider><OperationsNav />{children}</QueryProvider>
      </body>
    </html>
  );
}
