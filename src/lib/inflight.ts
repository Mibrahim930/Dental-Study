// Background AI work in progress (a lesson, a quiz, a practice exam, a topic map being written). A deploy stops the
// old server with SIGTERM; it waits a little for this work to finish, so what the student already paid for is saved
// instead of thrown away.

const running = new Set<Promise<unknown>>();

/** Register a piece of background work; returns the same promise. */
export function track<T>(p: Promise<T>): Promise<T> {
  running.add(p);
  const done = () => void running.delete(p);
  p.then(done, done);
  return p;
}

/** How many pieces of tracked work are still running. */
export function inflightCount(): number {
  return running.size;
}

/** Resolves when all tracked work has settled, or after `ms` at the latest. Never rejects. */
export async function settle(ms: number): Promise<void> {
  if (running.size === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  const all = (async () => {
    // Work started while waiting counts too.
    while (running.size > 0) await Promise.allSettled([...running]);
  })();
  await Promise.race([all, timeout]);
  if (timer) clearTimeout(timer);
}
