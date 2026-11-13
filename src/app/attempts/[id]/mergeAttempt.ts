// Folding a newer copy of the attempt (a poll, or the reply to an answer, report or finish) into the one on screen.
// While an exam is still being finished in the background, polls append questions at the end; nothing she is looking
// at may move. Pure, so it can be tested without a browser.

type QuestionLike = { id: number; position: number; chosen_index: number | null };
type ViewLike = { attempt: { status: string; time_limit_sec: number | null }; questions: QuestionLike[] };

const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

/**
 * The view to show after `fresh` arrives, given the one on screen (`old`) and the questions she reported here
 * (`gone`: a reply sent before her report could still list them).
 * - A finished exam stays finished (a late poll can't reopen it); a newly finished or not-yet-ready one is taken as is.
 * - Questions already on screen keep their place and their object, unless the fresh copy has an answer the screen
 *   doesn't (the reply to her answer, or another tab).
 * - New questions are added only after the last one on screen (by position), in order; anything else new is a
 *   question reported meanwhile and stays out.
 * - A timed exam's limit only grows.
 * - Nothing changed: `old` itself comes back, so React does not re-render.
 */
export function mergeAttempt<V extends ViewLike>(old: V, fresh: V, gone: ReadonlySet<number> = new Set()): V {
  if (old.attempt.status === "finished" && fresh.attempt.status !== "finished") return old;
  if (old.attempt.status !== "ready" || fresh.attempt.status !== "ready") return same(old, fresh) ? old : fresh;

  const freshById = new Map(fresh.questions.map((q) => [q.id, q]));
  const lastPosition = old.questions.reduce((m, q) => Math.max(m, q.position), -Infinity);
  const kept = old.questions
    .filter((q) => !gone.has(q.id))
    .map((q) => {
      const f = freshById.get(q.id);
      return q.chosen_index == null && f && f.chosen_index != null ? f : q;
    });
  const onScreen = new Set(old.questions.map((q) => q.id));
  const added = fresh.questions.filter((q) => !onScreen.has(q.id) && !gone.has(q.id) && q.position > lastPosition).sort((a, b) => a.position - b.position);
  const questions = added.length === 0 && kept.length === old.questions.length && kept.every((q, i) => q === old.questions[i]) ? old.questions : [...kept, ...added];

  const limit = old.attempt.time_limit_sec != null && fresh.attempt.time_limit_sec != null ? Math.max(old.attempt.time_limit_sec, fresh.attempt.time_limit_sec) : fresh.attempt.time_limit_sec;
  const freshAttempt = limit === fresh.attempt.time_limit_sec ? fresh.attempt : { ...fresh.attempt, time_limit_sec: limit };
  const attempt = same(old.attempt, freshAttempt) ? old.attempt : freshAttempt;

  // Everything else (plan, counts, coverage…) is taken from the fresh copy, keeping the old object when it is equal.
  const out: Record<string, unknown> = {};
  let changed = questions !== old.questions || attempt !== old.attempt;
  const oldRec = old as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(fresh)) {
    if (k === "attempt" || k === "questions") continue;
    const keep = k in oldRec && same(oldRec[k], v);
    out[k] = keep ? oldRec[k] : v;
    if (!keep) changed = true;
  }
  for (const k of Object.keys(oldRec)) if (!(k in fresh)) changed = true;
  if (!changed) return old;
  return { ...out, attempt, questions } as unknown as V;
}

/** How many questions `next` has that `prev` did not (for the "added at the end" toast). */
export function addedCount(prev: { questions: { id: number }[] }, next: { questions: { id: number }[] }): number {
  const had = new Set(prev.questions.map((q) => q.id));
  return next.questions.filter((q) => !had.has(q.id)).length;
}
