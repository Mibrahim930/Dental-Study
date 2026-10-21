// Reading a school calendar file (.ics: Canvas, Brightspace, Google, Outlook exports) into dated events.
// Small and tolerant on purpose: folded lines, CRLF/LF/CR, DATE and DATE-TIME starts (UTC, TZID or floating),
// escaped text. A repeating event (RRULE) is taken at its first date and marked as repeating. Never throws on bad input.
import type { ExamKind } from "./db";
import { isValidDate } from "./calendar";

export type IcsEvent = {
  uid: string | null;
  name: string;
  description: string;
  location: string;
  /** The day it happens in the student's time zone (YYYY-MM-DD). */
  date: string;
  allDay: boolean;
  recurring: boolean;
  looksLikeExam: boolean;
  course: string | null;
  kind: ExamKind;
};

export const MAX_ICS_EVENTS = 5000;
const MAX_DEPTH = 16;

/** Titles that look like an exam or assessment (whole words, so "contest" or "latest" don't count). "Endo Block" is a dental exam. */
export const EXAM_WORDS = /\b(exams?|quiz(?:zes)?|midterms?|finals?|tests?|practicals?|osces?|boards?|inbde|nbde|assessments?|blocks?)\b/i;

export function guessKind(title: string): ExamKind {
  if (/\b(inbde|nbde|boards?)\b/i.test(title)) return "board";
  if (/\b(practicals?|osces?|competenc(y|ies))\b/i.test(title)) return "practical";
  if (/\bquiz(zes)?\b/i.test(title)) return "quiz";
  if (/\b(exams?|midterms?|finals?|block|tests?|assessments?)\b/i.test(title)) return "block";
  return "other";
}

/** RFC 5545 TEXT unescaping: \n \N → newline, \, \; \\ → the character. */
export function unescapeText(s: string): string {
  return s.replace(/\\([\\;,nN])/g, (_, c: string) => (c === "n" || c === "N" ? "\n" : c));
}

/** Unfold continuation lines (a line starting with a space or tab continues the one before). */
export function unfoldLines(text: string): string[] {
  const out: string[] = [];
  for (const line of text.replace(/^﻿/, "").split(/\r\n|\n|\r/)) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && out.length) out[out.length - 1] += line.slice(1);
    else out.push(line);
  }
  return out;
}

type Prop = { name: string; params: Record<string, string>; value: string };

/** NAME;PARAM=a;PARAM2="b:c":value — colons and semicolons inside quotes don't count. */
export function parseProp(line: string): Prop | null {
  let i = 0;
  let inQuote = false;
  let colon = -1;
  for (; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuote = !inQuote;
    else if (ch === ":" && !inQuote) {
      colon = i;
      break;
    }
  }
  if (colon <= 0) return null;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const pieces: string[] = [];
  let cur = "";
  inQuote = false;
  for (const ch of head) {
    if (ch === '"') inQuote = !inQuote;
    if (ch === ";" && !inQuote) {
      pieces.push(cur);
      cur = "";
    } else cur += ch;
  }
  pieces.push(cur);
  const name = pieces[0].trim().toUpperCase();
  if (!name) return null;
  const params: Record<string, string> = {};
  for (const p of pieces.slice(1)) {
    const eq = p.indexOf("=");
    if (eq > 0) params[p.slice(0, eq).trim().toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, "");
  }
  return { name, params, value };
}

function ymdInZone(t: number, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(t));
  } catch {
    return new Date(t).toISOString().slice(0, 10);
  }
}

/** Milliseconds a zone is ahead of UTC at instant t. Throws RangeError for unknown zones. */
function zoneOffset(timezone: string, t: number): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: timezone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" })
      .formatToParts(new Date(t))
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) % 24, Number(parts.minute), Number(parts.second));
  return asUtc - Math.floor(t / 1000) * 1000;
}

/**
 * The day an event starts, in the student's zone. DATE values are taken as written; UTC times and times in a known TZID
 * are converted; floating times and unknown zones (e.g. Outlook's "Eastern Standard Time") keep their written date.
 */
export function startDate(prop: Prop, timezone: string): { date: string; allDay: boolean } | null {
  const v = prop.value.trim();
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/i.exec(v);
  if (!m) return null;
  const written = `${m[1]}-${m[2]}-${m[3]}`;
  if (!isValidDate(written)) return null;
  if (!m[4] || prop.params.VALUE?.toUpperCase() === "DATE") return { date: written, allDay: true };
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? "0"].map(Number);
  if (h > 23 || mi > 59 || s > 60) return { date: written, allDay: false };
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  if (m[7]) return { date: ymdInZone(wall, timezone), allDay: false };
  const tzid = prop.params.TZID?.replace(/^\/+/, "").replace(/^mozilla\.org\/[^/]+\//i, "");
  if (!tzid) return { date: written, allDay: false };
  try {
    let t = wall - zoneOffset(tzid, wall);
    t = wall - zoneOffset(tzid, t); // second pass settles daylight-saving edges
    return { date: ymdInZone(t, timezone), allDay: false };
  } catch {
    return { date: written, allDay: false };
  }
}

/** "Midterm [DENT 501 - Endo]" → name "Midterm", course "DENT 501 - Endo" (Canvas puts the course in brackets). */
export function splitCourse(summary: string): { name: string; course: string | null } {
  const m = /^(.*\S)\s*\[([^\]]{1,80})\]\s*$/.exec(summary);
  return m ? { name: m[1].trim(), course: m[2].trim() } : { name: summary, course: null };
}

/** Every usable event in an .ics file. Cancelled events and moved single occurrences of a repeat are left out. */
export function parseIcs(text: string, timezone: string): { events: IcsEvent[]; truncated: boolean } {
  const events: IcsEvent[] = [];
  const seen = new Set<string>();
  let truncated = false;
  const stack: string[] = [];
  let props: Prop[] = [];
  let ignoredDepth = 0; // BEGINs past MAX_DEPTH aren't tracked, so a hostile file can't make END lookups slow
  const finish = () => {
    if (events.length >= MAX_ICS_EVENTS) {
      truncated = true;
    } else {
      const ev = toEvent(props, timezone);
      if (ev) {
        const key = `${ev.uid ?? ""}|${ev.name.toLowerCase()}|${ev.date}`;
        if (!seen.has(key)) {
          seen.add(key);
          events.push(ev);
        }
      }
    }
    props = [];
  };
  for (const line of unfoldLines(String(text ?? ""))) {
    if (!line.trim()) continue;
    const upper = line.toUpperCase();
    if (upper.startsWith("BEGIN:")) {
      const comp = upper.slice(6).trim();
      // A new event while one is still open (its END:VEVENT is missing): keep the open one.
      const open = stack.lastIndexOf("VEVENT");
      if (comp === "VEVENT" && open !== -1) {
        finish();
        stack.length = open;
      }
      if (stack.length >= MAX_DEPTH) {
        ignoredDepth++;
        continue;
      }
      stack.push(comp);
      if (comp === "VEVENT") props = [];
      continue;
    }
    if (upper.startsWith("END:")) {
      const comp = upper.slice(4).trim();
      // Tolerate a missing END: pop back to the matching BEGIN if there is one.
      const at = stack.lastIndexOf(comp);
      if (at === -1) {
        if (ignoredDepth > 0) ignoredDepth--;
        continue;
      }
      const closesEvent = stack.slice(at).includes("VEVENT");
      stack.length = at;
      if (closesEvent) finish();
      continue;
    }
    if (ignoredDepth > 0 || stack[stack.length - 1] !== "VEVENT") continue; // VTIMEZONE, VALARM inside an event, VTODO…
    const p = parseProp(line);
    if (p) props.push(p);
  }
  // A cut-off file (no END:VEVENT / END:VCALENDAR at the end) still gives its last event.
  if (stack.includes("VEVENT")) finish();
  events.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
  return { events, truncated };
}

function toEvent(props: Prop[], timezone: string): IcsEvent | null {
  const get = (name: string) => props.find((p) => p.name === name);
  if (get("STATUS")?.value.trim().toUpperCase() === "CANCELLED") return null;
  if (get("RECURRENCE-ID")) return null; // a moved single occurrence; the series itself is listed once
  const dt = get("DTSTART");
  if (!dt) return null;
  const start = startDate(dt, timezone);
  if (!start) return null;
  const summary = unescapeText(get("SUMMARY")?.value ?? "").replace(/\s+/g, " ").trim();
  const { name, course } = splitCourse(summary || "Untitled event");
  const description = unescapeText(get("DESCRIPTION")?.value ?? "").slice(0, 2000);
  const location = unescapeText(get("LOCATION")?.value ?? "").trim().slice(0, 200);
  return {
    uid: get("UID")?.value.trim() || null,
    name: name.slice(0, 120),
    description,
    location,
    date: start.date,
    allDay: start.allDay,
    recurring: !!(get("RRULE") || get("RDATE")),
    looksLikeExam: EXAM_WORDS.test(summary),
    course,
    kind: guessKind(summary),
  };
}
