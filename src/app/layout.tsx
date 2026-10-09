import type { Metadata, Viewport } from "next";
import { Bricolage_Grotesque, Geist_Mono } from "next/font/google";
import "./globals.css";
import { currentUser } from "@/lib/user";
import { NavBar } from "@/components/NavBar";
import { Toaster } from "@/components/Toaster";
import { themeOf } from "@/lib/themes";
import { countDue } from "@/lib/practice";
import { plannerSettings, todayIn } from "@/lib/planner";

const shortDate = (ymd: string) => new Date(ymd + "T00:00:00").toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });

const bricolage = Bricolage_Grotesque({ variable: "--font-bricolage", subsets: ["latin"], axes: ["opsz"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Lolo's Study Buddy",
  description: "Study your own dental lectures with guided sessions and practice exams",
  appleWebApp: { title: "Study Buddy" },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#efede6" },
    { media: "(prefers-color-scheme: dark)", color: "#121211" },
  ],
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const user = await currentUser();
  const signedIn = !!user?.api_key_enc;
  return (
    <html lang="en" data-theme={themeOf(user?.theme)} className={`${bricolage.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col font-sans">
        {signedIn && <NavBar isAdmin={!!user.is_admin} reviewsDue={countDue(user.id)} dateLabel={shortDate(todayIn(plannerSettings(user.id).timezone))} />}
        <main className={`mx-auto w-full min-w-0 max-w-[1280px] flex-1 px-3.5 py-4 sm:px-8 sm:py-8 ${signedIn ? "pb-32 sm:pb-12" : ""}`}>{children}</main>
        <Toaster />
      </body>
    </html>
  );
}
