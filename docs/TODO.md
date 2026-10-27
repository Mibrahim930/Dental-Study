# To-do

Parked work, with what was already found out so the next session doesn't repeat the research. Open items from the
handoff (owner to-dos, known gaps) stay in `docs/HANDOFF.md` §9.

## Calendar second release (parked 2026-10-27, owner's call when to start)

What exists: year/month views, exams with countdowns, busy days (weekly repeats, skips), per-day hours and days off,
"Re-plan from today", schedule import (text/photo/PDF/.ics), "Exams without a date", the crunch heads-up, and the
Google/Apple subscription feed (`src/app/api/ics/[token]/route.ts`) with one all-day "Study plan" event per day.

Suggested order: 2, 1, 3, 4; 5 only if the owner says yes.

1. **Move or skip a single task.** Not started. `rebuildPlan` (`src/lib/planner.ts`) deletes every future `todo` row and
   regenerates, so a moved/skipped task must be remembered outside `plan_tasks` (a small per-task-choice table the planner
   honours when laying out days), plus Move/Skip controls on the task row (Home and the calendar day panel) and the feed.
   Medium.
2. **Feed alerts 3 days and 1 day before an exam.** Not started; the feed has no VALARM blocks. Small. Google Calendar
   ignores alarms in subscribed feeds, so only Apple Calendar users would get them.
3. **Class-shared exam dates.** `copyExam` (`src/lib/classes.ts`) copies `exam_date` once when a classmate adds the exam;
   later changes by the class owner don't reach copies. Work: propagate date changes to copies whose date the classmate
   hasn't changed herself, then re-plan for them. Small–medium.
4. **Weekly summary.** Not started. Simplest: a Monday card on Home or the calendar (tasks done, hours, exams coming,
   readiness change per exam). Small–medium.
5. **Email reminders.** Not started; the site can't send email (needs a provider, key, sender, scheduled job). Only if the
   owner says yes.

Questions to settle before planning in detail:
- Do alerts need to work on Google Calendar too? (Then it's an in-site reminder or email, not the feed.)
- Skipped task: gone for good, or re-planned later?
- Class dates: if a classmate set her own date, does the owner's later change overwrite it? (Suggested: no.)
- Weekly summary: site card only, or also a feed event?
- Email reminders in this release: yes or no?
