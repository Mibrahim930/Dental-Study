export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { resumeUnfinished, pollBatches } = await import("./lib/processing");
    resumeUnfinished();
    // Claude slide batches finish in the background; collect results every minute.
    setInterval(() => void pollBatches(), 60_000);
  }
}
