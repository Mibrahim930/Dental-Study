// Does a lesson mention every fact the slides list? A cheap word-overlap check (no AI) that decides whether the lesson
// writer gets one repair call for the facts it skipped.

const STOP = new Set(
  "the a an and or of to in on for with from by at as is are was were be been being this that these those it its into than then which who whom whose what when where while can may might must should would could will shall not no nor but if so such also only more most less least very each per via about between among through during before after over under again further once here there all any both few other some own same too".split(
    " ",
  ),
);

/** Significant words of a phrase: letters/digits, 3+ characters (numbers of any length), not stopwords, lower-cased. */
export function keyWords(s: string): string[] {
  return (s.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}.'-]*/gu) ?? [])
    .map((w) => w.replace(/^[.'-]+|[.'-]+$/g, ""))
    .filter((w) => w && !STOP.has(w) && (w.length >= 3 || /\d/.test(w)));
}

/**
 * Which facts the text covers. A fact counts as covered when at least 60% of its significant words appear in the
 * text (a fact with no significant words counts as covered). Word stems are matched loosely: "pulpal" covers "pulp".
 */
export function coveredFacts(text: string, facts: string[]): { covered: string[]; missing: string[]; ratio: number } {
  const have = new Set(keyWords(text));
  const stems = new Set([...have].map(stem));
  const covered: string[] = [];
  const missing: string[] = [];
  for (const f of facts) {
    const ws = keyWords(f);
    if (ws.length === 0) {
      covered.push(f);
      continue;
    }
    const hit = ws.filter((w) => have.has(w) || stems.has(stem(w))).length;
    (hit / ws.length >= 0.6 ? covered : missing).push(f);
  }
  const total = covered.length + missing.length;
  return { covered, missing, ratio: total === 0 ? 1 : covered.length / total };
}

/** A text as a run of lower-cased words (letters and digits only), for word-for-word matching. */
function wordRun(s: string): string[] {
  return (s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(Boolean);
}

/** The fewest words a fact needs before it can count as copied: shorter ones can hardly be said another way. */
export const QUOTE_MIN_WORDS = 5;

/**
 * Which facts the text copies word for word rather than explains. A fact of at least QUOTE_MIN_WORDS words counts as
 * copied when a run of 70% of its words (at least QUOTE_MIN_WORDS) appears in the text in the same order, punctuation
 * and case aside. Shorter facts are not judged and are not in the ratio. `ratio` is copied / judged (0 when nothing is
 * long enough to judge), so a lesson that explains in its own words scores 0 and one pasted from the slides scores 1.
 */
export function quotedFacts(text: string, facts: string[]): { quoted: string[]; judged: number; ratio: number } {
  const hay = ` ${wordRun(text).join(" ")} `;
  const quoted: string[] = [];
  let judged = 0;
  for (const f of facts) {
    const ws = wordRun(f);
    if (ws.length < QUOTE_MIN_WORDS) continue;
    judged++;
    const run = Math.max(QUOTE_MIN_WORDS, Math.ceil(ws.length * 0.7));
    let hit = false;
    for (let i = 0; i + run <= ws.length && !hit; i++) hit = hay.includes(` ${ws.slice(i, i + run).join(" ")} `);
    if (hit) quoted.push(f);
  }
  return { quoted, judged, ratio: judged === 0 ? 0 : quoted.length / judged };
}

/**
 * A crude stem: drops common English endings so "pulpal"/"pulps" meet "pulp" and "fractures"/"nerves" meet
 * "fracture"/"nerve" (a trailing e goes too, on both sides). Numbers and short words are left alone.
 */
function stem(w: string): string {
  if (/\d/.test(w) || w.length <= 4) return w;
  // Plural first, then the derivational endings, then a trailing e — so "canals" and "canal" land on the same stem.
  return w
    .replace(/(ies|es|s)$/, "")
    .replace(/(ically|ation|ations|ities|ity|ness|ments|ment|ingly|ing|edly|ed|ers|er|est|ally|al|ous|ive|ly)$/, "")
    .replace(/e$/, "");
}
