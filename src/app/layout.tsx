import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { currentUser } from "@/lib/user";
import { NavBar } from "@/components/NavBar";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Dental Study",
  description: "Study your own dental lectures with guided sessions and practice exams",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#121820" },
  ],
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const user = await currentUser();
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col font-sans">
        {user?.api_key_enc && <NavBar isAdmin={!!user.is_admin} />}
        <main className={`mx-auto w-full min-w-0 max-w-6xl flex-1 px-4 py-6 ${user?.api_key_enc ? "pb-24 sm:pb-8" : ""}`}>{children}</main>
      </body>
    </html>
  );
}
