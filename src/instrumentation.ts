export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { resumeUnfinished } = await import("./lib/processing");
    resumeUnfinished();
  }
}
