export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { resumeUnfinished, pollBatches } = await import("./lib/processing");
    const { db } = await import("./lib/db");
    resumeUnfinished();
    // Claude slide batches finish in the background; collect results every minute.
    setInterval(() => void pollBatches(), 60_000);

    // Railway stops the old container with SIGTERM on every deploy. Exit cleanly (code 0) so it
    // isn't reported as a crash. Unfinished slide work resumes on the next start.
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      process.once(signal, () => {
        try {
          db.close();
        } finally {
          process.exit(0);
        }
      });
    }
  }
}
