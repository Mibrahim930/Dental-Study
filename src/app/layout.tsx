import type { Metadata } from "next";
import Link from "next/link";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { currentUser } from "@/lib/user";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Dental Study",
  description: "Study your own dental lectures with guided sessions and practice exams",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const user = await currentUser();
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col font-sans">
        {user?.api_key_enc && (
        <header className="border-b border-slate-200 bg-white">
          <nav className="mx-auto flex max-w-6xl items-center gap-4 overflow-x-auto whitespace-nowrap px-4 py-3 text-sm sm:gap-6">
            <Link href="/" className="shrink-0 text-base font-semibold text-teal-800">
              🦷 Dental Study
            </Link>
            <Link href="/" className="text-slate-600 hover:text-slate-900">Exams</Link>
            <Link href="/calendar" className="text-slate-600 hover:text-slate-900">Calendar</Link>
            <Link href="/review" className="text-slate-600 hover:text-slate-900">Daily review</Link>
            <Link href="/progress" className="text-slate-600 hover:text-slate-900">Progress</Link>
            {user.is_admin ? (
              <Link href="/admin" className="ml-auto text-slate-600 hover:text-slate-900">Admin</Link>
            ) : null}
            <Link href="/settings" className={`${user.is_admin ? "" : "ml-auto "}text-slate-600 hover:text-slate-900`}>Settings</Link>
          </nav>
        </header>
        )}
        <main className="mx-auto w-full min-w-0 max-w-6xl flex-1 px-4 py-6">{children}</main>
      </body>
    </html>
  );
}
