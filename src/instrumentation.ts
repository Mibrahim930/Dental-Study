/**
 * In production the site must not start half-configured: with no APP_PASSCODE the gate is open to anyone, with no
 * SECRET_KEY every request fails, and with no DATA_DIR (or a relative one) the database lands in a folder that a
 * deploy throws away. Returns what is missing, or null when all is set. Not checked in development or tests.
 */
export function missingProductionConfig(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.NODE_ENV !== "production" || env.NEXT_PHASE === "phase-production-build") return null;
  const missing: string[] = [];
  if (!env.SECRET_KEY?.trim()) missing.push("SECRET_KEY is empty");
  if (!env.APP_PASSCODE?.trim()) missing.push("APP_PASSCODE is empty");
  if (!env.DATA_DIR?.trim()) missing.push("DATA_DIR is not set");
  else if (!env.DATA_DIR.startsWith("/") && !/^[a-zA-Z]:[\\/]/.test(env.DATA_DIR)) missing.push(`DATA_DIR is not an absolute path (${env.DATA_DIR})`);
  return missing.length ? missing.join(", ") : null;
}

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const missing = missingProductionConfig();
    if (missing) {
      console.error(`Refusing to start: ${missing}. Set it in the server's environment variables.`);
      process.exit(1);
    }
    const { resumeUnfinished, pollBatches } = await import("./lib/processing");
    const { backupIfDue } = await import("./lib/backup");
    const { db } = await import("./lib/db");
    const { settle } = await import("./lib/inflight");
    resumeUnfinished();
    // Exams in progress that still hold unanswered questions from another exam (older versions mixed them in): take them out.
    try {
      const { dropForeignQuestions } = await import("./lib/practice");
      const n = dropForeignQuestions();
      if (n) console.log(`Removed ${n} unanswered question(s) from other exams out of practice exams in progress`);
    } catch (err) {
      console.error("Cleaning other exams' questions out of open practice exams failed", err);
    }
    // Questions written before pictures were enforced: give them their slide's picture, or take them out (once per
    // version of the check; the Admin page can run it again).
    try {
      const { repairPictureQuestionsOnce } = await import("./lib/questionImage");
      const fixed = repairPictureQuestionsOnce();
      if (fixed) console.log(`Repaired ${fixed} question(s) that mentioned a picture without showing one`);
    } catch (err) {
      console.error("Repairing questions that mention a picture failed", err);
    }
    // Practice exams that were being written when the server stopped would wait forever: they become "error" (Start again).
    try {
      const { failStaleAttempts } = await import("./lib/practice");
      const stale = failStaleAttempts();
      if (stale) console.log(`Marked ${stale} practice exam(s) interrupted while being written as failed`);
    } catch (err) {
      console.error("Marking interrupted practice exams failed", err);
    }
    // One-time upgrade: topic maps built before they were per lecture are re-mapped by lecture, one exam at a time, in
    // the background (each exam once; a restart carries on with the rest). Failures are logged and leave the old map.
    try {
      // Section-quiz progress used to live per study session; copy it once into the per-student table.
      try {
        const { migrateSessionChecks } = await import("./lib/quizProgress");
        const moved = migrateSessionChecks();
        if (moved) console.log(`Quiz progress: copied ${moved} earlier answers into quiz_answers`);
      } catch (err) {
        console.error("Quiz progress migration failed", err);
      }
      const { rebuildLectureMaps } = await import("./lib/topics");
      void rebuildLectureMaps()
        .then((n) => n && console.log(`Reorganised ${n} exam(s)' topics by lecture`))
        .catch((err) => console.error("Reorganising topics by lecture failed", err));
    } catch (err) {
      console.error("Reorganising topics by lecture failed", err);
    }
    // Lessons written before the filler trim: any that end in "Done. Ok. Bye." are cleaned once per version of the check
    // (null when this version already ran), and the Admin page shows which ones were found.
    try {
      const { scanLessonsForFillerOnce } = await import("./lib/study");
      const scan = scanLessonsForFillerOnce();
      if (scan) console.log(`Lesson filler check: ${scan.checked} lesson(s) checked, ${scan.found.length} cleaned`);
    } catch (err) {
      console.error("Lesson filler check failed", err);
    }
    // Claude slide batches finish in the background; collect results every minute.
    const poll = setInterval(() => void pollBatches(), 60_000);
    // Daily off-disk backup (checked hourly; first check shortly after start).
    const firstBackup = setTimeout(() => void backupIfDue(), 2 * 60_000);
    const backups = setInterval(() => void backupIfDue(), 60 * 60_000);

    // Railway stops the old container with SIGTERM on every deploy. AI work already under way (a lesson, a quiz, a
    // practice exam, a topic map, slides being read) is paid for, so it gets up to 25 seconds to finish and be saved;
    // then the database is closed and the process exits cleanly (code 0) so it isn't reported as a crash. Unfinished
    // slide work resumes on the next start.
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      clearInterval(poll);
      clearTimeout(firstBackup);
      clearInterval(backups);
      try {
        await settle(25_000);
      } finally {
        try {
          db.close();
        } finally {
          process.exit(0);
        }
      }
    };
    for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => void stop());
  }
}
