export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { resumeUnfinished, pollBatches } = await import("./lib/processing");
    const { backupIfDue } = await import("./lib/backup");
    const { db } = await import("./lib/db");
    resumeUnfinished();
    // Exams in progress that still hold unanswered questions from another exam (older versions mixed them in): take them out.
    try {
      const { dropForeignQuestions } = await import("./lib/practice");
      const n = dropForeignQuestions();
      if (n) console.log(`Removed ${n} unanswered question(s) from other exams out of practice exams in progress`);
      // Questions written before pictures were enforced: give them their slide's picture, or take them out.
      const { repairPictureQuestions } = await import("./lib/questionImage");
      const fixed = repairPictureQuestions();
      if (fixed) console.log(`Repaired ${fixed} question(s) that mentioned a picture without showing one`);
    } catch (err) {
      console.error("Cleaning other exams' questions out of open practice exams failed", err);
    }
    // Claude slide batches finish in the background; collect results every minute.
    setInterval(() => void pollBatches(), 60_000);
    // Daily off-disk backup (checked hourly; first check shortly after start).
    setTimeout(() => void backupIfDue(), 2 * 60_000);
    setInterval(() => void backupIfDue(), 60 * 60_000);

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
