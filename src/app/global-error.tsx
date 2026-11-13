"use client"; // Error boundaries must be client components.
import { useEffect } from "react";
import "./globals.css";

/**
 * Last resort when the root layout itself fails (the nav bar and theme come from it, so this page brings its own
 * html and body). Plain message, "Try again", and a full page load home. Nothing here may touch the database.
 */
export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <html lang="en">
      <body className="flex min-h-full flex-col bg-background font-sans text-foreground antialiased">
        <title>Something went wrong · Lolo&apos;s Dental Buddy</title>
        <main className="mx-auto w-full max-w-lg px-3.5 py-10">
          <section className="card flex flex-col gap-3" role="alert">
            <h1 className="section-title">Something went wrong.</h1>
            <p className="text-[15px] text-muted-foreground">The site couldn&apos;t load this page. Your work is saved. Try again, or go back to your exams.</p>
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn-primary btn-sm" onClick={() => retry()}>
                Try again
              </button>
              {/* A plain link on purpose: a full page load rebuilds the layout that just failed. */}
              {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
              <a href="/" className="btn-secondary btn-sm">
                Back to my exams
              </a>
            </div>
          </section>
        </main>
      </body>
    </html>
  );
}
