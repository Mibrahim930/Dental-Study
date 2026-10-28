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

/**
 * A text as a run of lower-cased words (letters, marks and digits only), for word-for-word matching. Composed first,
 * so "ü" written as u + combining diaeresis is the same word as the precomposed one.
 */
function wordRun(s: string): string[] {
  return (s.normalize("NFC").toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) ?? []).filter(Boolean);
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

/** How many filler lines in a row mark the point where an explanation stopped teaching. */
export const RAMBLE_RUN = 3;

/**
 * A line that says nothing: at most three words of plain prose ("Done.", "Ok.", "(Keep going.)", "End of slide."), or
 * only punctuation. Headings, list items, table rows, quotes and lead-ins that end in ":" are never filler, nor is
 * a line with a number in it.
 */
function isFiller(line: string): boolean {
  const t = line.trim();
  if (t === "") return false;
  // A whole line in parentheses is an aside the drifting writer is fond of ("(Keep going.)", "(Note: …)"); on its
  // own it stays, in a run it goes.
  if (/^\(.*\)$/.test(t)) return true;
  if (/^([#>|]|[-*+]\s|\d+[.)]\s)/.test(t) || t.endsWith(":")) return false;
  const words = t.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? [];
  if (words.some((w) => /\d/.test(w))) return false;
  return words.length <= 3;
}

/**
 * Cut the filler a writer can drift into at the end of a long explanation ("Done. Ok. Stop. . . End of slide. Bye."):
 * everything from the first run of RAMBLE_RUN filler lines in a row to the end goes, and so do filler lines left
 * trailing at the end. Real explanations are sentences, so a short plain line is rare and three in a row never happen.
 */
export function trimRamble(text: string): { text: string; trimmed: boolean } {
  const lines = text.split("\n");
  // Lines inside a code fence are whatever they are, never filler.
  let inFence = false;
  const filler = lines.map((l) => {
    if (/^\s*(```|~~~)/.test(l)) {
      inFence = !inFence;
      return false;
    }
    return !inFence && isFiller(l);
  });
  // A text with nothing but short lines: a genuinely short explanation ("See the picture.") stays; a run of filler
  // and nothing else is all filler.
  if (!lines.some((l, i) => l.trim() !== "" && !filler[i])) {
    const short = filler.filter(Boolean).length;
    return short >= RAMBLE_RUN ? { text: "", trimmed: true } : { text: text.trimEnd(), trimmed: false };
  }
  let cut = lines.length;
  for (let i = 0, run = 0, runStart = 0; i < lines.length; i++) {
    if (lines[i].trim() === "") continue; // blank lines don't break a run (paragraphs are separated by them)
    if (!filler[i]) {
      run = 0;
      continue;
    }
    if (run === 0) runStart = i;
    if (++run >= RAMBLE_RUN) {
      cut = runStart;
      break;
    }
  }
  while (cut > 0 && (lines[cut - 1].trim() === "" || filler[cut - 1])) cut--;
  const kept = lines.slice(0, cut).join("\n").trimEnd();
  return { text: kept, trimmed: kept !== text.trimEnd() };
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
