// Calendar release, job 5: importing a school calendar file (.ics) — tolerant parser, exam filter, same confirm screen.
import { describe, expect, it, vi } from "vitest";

let currentUserId = 0;
vi.mock("@/lib/user", async (orig) => ({
  ...(await orig<typeof import("@/lib/user")>()),
  apiUser: async () => (currentUserId ? { id: currentUserId } : null),
}));

import { db } from "@/lib/db";
import { POST } from "@/app/api/calendar/import/ics/route";
import { addDays, plannerSettings, todayIn } from "@/lib/planner";
import { guessKind, parseIcs, parseProp, splitCourse, startDate, unescapeText, unfoldLines } from "@/lib/icsImport";
import { icsRows } from "@/components/ImportSchedule";
import { duplicateKey } from "@/lib/calendar";
import { makeUser } from "./helpers";

const c = (d: string) => d.replaceAll("-", "");
const crlf = (lines: string[]) => lines.join("\r\n") + "\r\n";

// Google Calendar export: VTIMEZONE block, TZID times, escaped commas, a folded description, an alarm inside the event.
const GOOGLE = crlf([
  "BEGIN:VCALENDAR",
  "PRODID:-//Google Inc//Google Calendar 70.9054//EN",
  "VERSION:2.0",
  "X-WR-CALNAME:D2 Fall",
  "BEGIN:VTIMEZONE",
  "TZID:America/New_York",
  "BEGIN:DAYLIGHT",
  "DTSTART:19700308T020000",
  "TZOFFSETFROM:-0500",
  "END:DAYLIGHT",
  "END:VTIMEZONE",
  "BEGIN:VEVENT",
  "DTSTART;TZID=America/New_York:20261104T090000",
  "DTEND;TZID=America/New_York:20261104T110000",
  "UID:abc123@google.com",
  "SUMMARY:Endo Block Exam 2\\, Room 204",
  "DESCRIPTION:Covers lectures 5–9. Bring a pencil\\; no calculators. Long text t",
  " hat was folded by the exporter.",
  "LOCATION:Hall A\\, 2nd floor",
  "BEGIN:VALARM",
  "ACTION:DISPLAY",
  "DESCRIPTION:This is an event reminder",
  "SUMMARY:Alarm summary that must not win",
  "TRIGGER:-P0DT0H30M0S",
  "END:VALARM",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "DTSTART;VALUE=DATE:20261126",
  "DTEND;VALUE=DATE:20261128",
  "UID:hol@google.com",
  "SUMMARY:Thanksgiving break",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "DTSTART;TZID=America/New_York:20260908T080000",
  "RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20261215T130000Z",
  "UID:quiz-weekly@google.com",
  "SUMMARY:Weekly Perio Quiz",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "DTSTART;TZID=America/New_York:20260915T080000",
  "RECURRENCE-ID;TZID=America/New_York:20260915T080000",
  "UID:quiz-weekly@google.com",
  "SUMMARY:Weekly Perio Quiz (moved)",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "DTSTART:20261201T150000Z",
  "STATUS:CANCELLED",
  "UID:gone@google.com",
  "SUMMARY:Cancelled practical",
  "END:VEVENT",
  "END:VCALENDAR",
]);

// Canvas export: all-day assignments, course in [brackets], UTC due times late at night.
const CANVAS = crlf([
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//Instructure//Canvas//EN",
  "X-WR-CALNAME:Lolo Calendar (Canvas)",
  "BEGIN:VEVENT",
  "DTSTAMP:20261001T120000Z",
  "DTSTART;VALUE=DATE:20261110",
  "DTEND;VALUE=DATE:20261110",
  "SUMMARY:Midterm Exam [DENT 501 - Endodontics]",
  "UID:event-assignment-1001",
  "URL;VALUE=URI:https://school.instructure.com/courses/1/assignments/1001",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "DTSTAMP:20261001T120000Z",
  "DTSTART:20261113T045900Z",
  "DTEND:20261113T045900Z",
  "SUMMARY:Case write-up due [DENT 502 - Perio]",
  "UID:event-assignment-1002",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "DTSTART:20261203T145900Z",
  "SUMMARY:OSCE Station Practical [DENT 510 - Clinic]",
  "UID:event-assignment-1003",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "DTSTART;VALUE=DATE:20270115",
  "SUMMARY:INBDE practice assessment",
  "UID:event-1004",
  "END:VEVENT",
  "END:VCALENDAR",
]);

describe("ICS parser pieces", () => {
  it("unfolds CRLF, LF, CR and tab-folded lines and drops a BOM", () => {
    expect(unfoldLines("﻿A:1\r\n B\nC:2\r\tD\rE:3")).toEqual(["A:1B", "C:2D", "E:3"]);
  });

  it("reads params, including quoted values with colons and semicolons", () => {
    expect(parseProp('DTSTART;TZID="America/New_York";X-A="a:b;c":20261104T090000')).toEqual({
      name: "DTSTART",
      params: { TZID: "America/New_York", "X-A": "a:b;c" },
      value: "20261104T090000",
    });
    expect(parseProp("no colon here")).toBeNull();
    expect(parseProp(":value only")).toBeNull();
  });

  it("unescapes text", () => {
    expect(unescapeText("a\\, b\\; c\\\\d\\ne\\Nf")).toBe("a, b; c\\d\ne\nf");
  });

  it("dates: DATE as written, UTC converted to her zone, TZID converted, floating and unknown zones as written", () => {
    expect(startDate({ name: "DTSTART", params: { VALUE: "DATE" }, value: "20261110" }, "America/Chicago")).toEqual({ date: "2026-11-10", allDay: true });
    // 04:59 UTC on the 13th is 10:59 pm on the 12th in Chicago.
    expect(startDate({ name: "DTSTART", params: {}, value: "20261113T045900Z" }, "America/Chicago")).toEqual({ date: "2026-11-12", allDay: false });
    // 11 pm in Los Angeles is already the next day in New York.
    expect(startDate({ name: "DTSTART", params: { TZID: "America/Los_Angeles" }, value: "20261104T230000" }, "America/New_York")!.date).toBe("2026-11-05");
    expect(startDate({ name: "DTSTART", params: { TZID: "Eastern Standard Time" }, value: "20261104T230000" }, "Asia/Tokyo")!.date).toBe("2026-11-04");
    expect(startDate({ name: "DTSTART", params: { TZID: "/mozilla.org/20050126_1/Europe/London" }, value: "20261104T230000" }, "Europe/London")!.date).toBe("2026-11-04");
    expect(startDate({ name: "DTSTART", params: {}, value: "20261104T230000" }, "Asia/Tokyo")!.date).toBe("2026-11-04");
    expect(startDate({ name: "DTSTART", params: {}, value: "20261332" }, "UTC")).toBeNull();
    expect(startDate({ name: "DTSTART", params: {}, value: "garbage" }, "UTC")).toBeNull();
  });

  it("guesses the type and splits a Canvas course off the name", () => {
    expect(guessKind("INBDE practice assessment")).toBe("board");
    expect(guessKind("OSCE Station")).toBe("practical");
    expect(guessKind("Perio Quiz 3")).toBe("quiz");
    expect(guessKind("Midterm")).toBe("block");
    expect(guessKind("Lecture 4")).toBe("other");
    expect(splitCourse("Midterm Exam [DENT 501 - Endodontics]")).toEqual({ name: "Midterm Exam", course: "DENT 501 - Endodontics" });
    expect(splitCourse("No course here")).toEqual({ name: "No course here", course: null });
  });
});

describe("parsing real-world-shaped files", () => {
  it("Google export: the alarm doesn't override the event, repeats take their first date, moved and cancelled ones are left out", () => {
    const { events } = parseIcs(GOOGLE, "America/New_York");
    expect(events.map((e) => [e.name, e.date, e.looksLikeExam, e.recurring])).toEqual([
      ["Weekly Perio Quiz", "2026-09-08", true, true],
      ["Endo Block Exam 2, Room 204", "2026-11-04", true, false],
      ["Thanksgiving break", "2026-11-26", false, false],
    ]);
    const endo = events.find((e) => e.name.startsWith("Endo"))!;
    expect(endo.description).toBe("Covers lectures 5–9. Bring a pencil; no calculators. Long text that was folded by the exporter.");
    expect(endo.location).toBe("Hall A, 2nd floor");
    expect(endo.kind).toBe("block");
    expect(events.find((e) => e.name === "Thanksgiving break")!.allDay).toBe(true);
  });

  it("Canvas export: course from brackets, UTC due times land on her local day, exam words picked out", () => {
    const { events } = parseIcs(CANVAS, "America/Chicago");
    expect(events.map((e) => [e.name, e.date, e.course, e.kind, e.looksLikeExam])).toEqual([
      ["Midterm Exam", "2026-11-10", "DENT 501 - Endodontics", "block", true],
      ["Case write-up due", "2026-11-12", "DENT 502 - Perio", "other", false],
      ["OSCE Station Practical", "2026-12-03", "DENT 510 - Clinic", "practical", true],
      ["INBDE practice assessment", "2027-01-15", null, "board", true],
    ]);
  });

  it("LF-only files, lowercase keywords and a missing END:VCALENDAR still parse", () => {
    const lf = "begin:vcalendar\nbegin:vevent\ndtstart;value=date:20261201\nsummary:Final exam\nend:vevent\n";
    expect(parseIcs(lf, "UTC").events.map((e) => [e.name, e.date])).toEqual([["Final exam", "2026-12-01"]]);
  });

  it("words inside other words don't count as exams", () => {
    const f = crlf(["BEGIN:VCALENDAR", "BEGIN:VEVENT", "DTSTART;VALUE=DATE:20261201", "SUMMARY:Latest contest results", "END:VEVENT", "END:VCALENDAR"]);
    expect(parseIcs(f, "UTC").events[0].looksLikeExam).toBe(false);
  });

  it("never throws on malformed or random input", () => {
    const samples = [
      "",
      "BEGIN:VEVENT",
      "END:VEVENT\r\nEND:VCALENDAR",
      "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART\r\nSUMMARY\r\nEND:VEVENT",
      "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART;TZID=Nowhere/Land:20261301T250000\r\nEND:VEVENT",
      "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART;TZID=\"unterminated:20261101T100000\r\nEND:VEVENT",
      "\u0000\u0001￿" + "x".repeat(5000),
      " leading fold\r\n\tmore",
    ];
    let seed = 42;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const alphabet = ["BEGIN:", "END:", "VEVENT", "VCALENDAR", "DTSTART", ";", ":", "=", '"', "\r\n", "\n", " ", "\t", "2026", "1104", "T", "Z", "\\", "TZID", "VALUE=DATE", "SUMMARY", "Exam"];
    for (let i = 0; i < 300; i++) samples.push(Array.from({ length: 80 }, () => alphabet[Math.floor(rand() * alphabet.length)]).join(""));
    for (const s of samples) expect(() => parseIcs(s, "America/New_York")).not.toThrow();
    expect(() => parseIcs(GOOGLE, "Not/AZone")).not.toThrow();
    expect(() => parseIcs(undefined as never, "UTC")).not.toThrow();
  });
});

describe("the .ics route and the check screen rows", () => {
  const upload = (content: string, name = "school.ics") => {
    const body = new FormData();
    body.set("file", new File([content], name, { type: "text/calendar" }));
    return POST(new Request("http://x/api/calendar/import/ics", { method: "POST", body }));
  };

  it("returns events with past flags and saves nothing", async () => {
    const u = makeUser();
    currentUserId = u;
    const today = todayIn(plannerSettings(u).timezone);
    const file = crlf([
      "BEGIN:VCALENDAR",
      ...[
        [addDays(today, -20), "Old Quiz 1"],
        [addDays(today, 9), "Endo Block Exam"],
        [addDays(today, 10), "Lecture 12"],
        [addDays(today, -800), "Ancient final"],
      ].flatMap(([d, s]) => ["BEGIN:VEVENT", `DTSTART;VALUE=DATE:${c(d)}`, `SUMMARY:${s}`, "END:VEVENT"]),
      "END:VCALENDAR",
    ]);
    const before = (db.prepare("SELECT COUNT(*) n FROM exams").get() as { n: number }).n;
    const res = await upload(file);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(4);
    expect(body.events.map((e: { name: string; past: boolean }) => [e.name, e.past])).toEqual([
      ["Old Quiz 1", true],
      ["Endo Block Exam", false],
      ["Lecture 12", false],
    ]);
    expect((db.prepare("SELECT COUNT(*) n FROM exams").get() as { n: number }).n).toBe(before);

    // Default: upcoming exam-like only. Toggles add the rest; non-exam events start unticked.
    const ev = body.events;
    const keys = new Set([duplicateKey("Endo Block Exam", addDays(today, 9))]);
    expect(icsRows(ev, { showAll: false, includePast: false }, new Set()).map((r) => [r.name, r.include])).toEqual([["Endo Block Exam", true]]);
    expect(icsRows(ev, { showAll: true, includePast: false }, new Set()).map((r) => [r.name, r.include])).toEqual([
      ["Endo Block Exam", true],
      ["Lecture 12", false],
    ]);
    expect(icsRows(ev, { showAll: false, includePast: true }, new Set()).map((r) => r.name)).toEqual(["Old Quiz 1", "Endo Block Exam"]);
    expect(icsRows(ev, { showAll: false, includePast: false }, keys)[0].include).toBe(false); // already on her calendar
  });

  it("a file that isn't a calendar, an empty upload, broken bytes and signed-out requests get plain answers", async () => {
    currentUserId = makeUser();
    let r = await upload("hello, I am a CSV,1,2,3");
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/doesn't look like a calendar file/);
    r = await upload("");
    expect((await r.json()).error).toMatch(/Choose a calendar file/);
    r = await upload("BEGIN:VCALENDAR\r\n\u0000ÿ\ud800garbage\r\nBEGIN:VEVENT\r\nDTSTART:zzz\r\n");
    expect(r.status).toBe(200);
    expect((await r.json()).events).toEqual([]);
    r = await POST(new Request("http://x", { method: "POST", body: "not a form", headers: { "content-type": "multipart/form-data; boundary=x" } }));
    expect(r.status).toBe(400);
    currentUserId = 0;
    expect((await upload(CANVAS)).status).toBe(401);
  });
});
