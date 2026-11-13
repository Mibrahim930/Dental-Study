# Lolo's Dental Buddy (Dental Study)

A study tool for dental students, built around their own lecture PDFs. Many students can use one site: each has their own account, data and AI key.

- **Access:** a site passcode, then email + password accounts. Each user adds their own **Claude or ChatGPT API key** (stored encrypted) and pays for their own usage. There's a step-by-step guide at `/help/api-keys`.
- **Exam workspaces:** upload lecture PDFs. Every slide (images, radiographs, handwritten notes) is read once by AI. Claude users go through the Batch API at half price.
- **Topic map, study sessions with slide-by-slide lessons and section quizzes, practice exams (recall / INBDE-style case / image), daily spaced review, progress.**
- **While studying:** highlight or underline words in a lesson, "Quiz me on this" on any passage, and a lecture review at the end of each lecture that re-asks what she got wrong. Every question has a Report button.
- **Memory across exams:** each user's concept mastery, slide library and session summaries carry over from one exam to the next.
- **Spending tracker:** Settings shows each user's estimated AI spend.
- **Calendar and study planner:** year and month calendar with exams (each one is an exam workspace) and busy days. A paced day-by-day plan across all upcoming exams, "Today's plan" on the home page, tasks that tick themselves off, and a calendar subscription link for Google or Apple Calendar.
- **Practice:** recall, case, image, and **INBDE-style case sets** (one patient, 3–5 questions).
- **Classes:** invite codes, and shared exams classmates can add with no AI cost. Progress stays private, and a reported question is hidden class-wide.
- **Admin** (`/admin`, first account): users, password resets with a temporary password, account removal, spending, reports from the flag button, reported questions (with a download), the lesson filler check, backup status.

## Run it locally

1. `npm install`
2. Copy `.env.example` to `.env.local` and set `APP_PASSCODE` and `SECRET_KEY` (`openssl rand -base64 32`).
3. `npm run dev`, then open http://localhost:3000, enter the passcode, create an account, and add an API key.

Data goes to `./data` (SQLite + PDFs + slide images) unless `DATA_DIR` is set.

To load a folder of lecture PDFs from the command line: `npm run import -- you@example.com "Exam name" YYYY-MM-DD "/path/to/lectures"`. It reads `.env.local`, so it writes to your **local** data folder (`./data`, or `DATA_DIR` if you set one there), **not** to the live site. The account must already exist there with an API key.

## Models and costs

| | Claude (`claude-sonnet-5-5`) | ChatGPT (`gpt-6.1-sol`) |
|---|---|---|
| Reading a 500-slide exam (once) | ~$3 (batched, 50% off) | ~$6 |
| One topic lesson (generated once, cached) | ~2.5¢ | ~2.5¢ |
| 10-question practice exam | ~10¢ | ~10¢ |

Measured on the Claude path with a real 53-slide lecture. The ChatGPT figures are estimates. Questions from abandoned or skipped practice exams are reused instead of being regenerated.

Writing questions (section quizzes, practice exams, case sets, "Quiz me") uses the higher-priced model: `claude-opus-5-5` on Claude keys, which costs twice as much per word as Sonnet. The figures above were measured before that change, so quizzes and practice exams now cost more than shown. Reading slides, lessons and the question checker stay on the standard model. On ChatGPT keys the question writer is the same model unless `OPENAI_QUALITY_MODEL` is set.

`CLAUDE_MODEL` and `OPENAI_MODEL` override the standard models; `CLAUDE_QUALITY_MODEL` and `OPENAI_QUALITY_MODEL` override the question writers.

## Checks and tests

- `npm test` runs the Vitest suite. Every test file gets its own throwaway database, deleted when the run ends; the AI is always replaced by a stand-in, so tests never bill anyone.
- `npm run typecheck` checks the TypeScript types (it needs extra memory, which the script sets).
- `npx eslint src tests` checks the code style rules.
- On GitHub, every push and pull request runs these automatically (`.github/workflows/ci.yml`): install, types, lint, the whole test suite, and a check for known security problems in the packages the live site uses. Look for the green tick before publishing; Railway deploys every push to `main` whether or not the checks passed.

## Backups and restore

- Every day the app copies a database snapshot (`db/study-YYYY-MM-DD.db.gz`, last 14 kept), any new lecture PDFs (`pdfs/doc-<id>.pdf`), report screenshots and reported-question files to the Railway bucket `dental-study-backups` (`BACKUP_S3_*` variables). Status and a "Back up now" button are on `/admin`.
- `railway run npx tsx scripts/list-backups.mts` lists what's stored.
- `railway run npx tsx scripts/inspect-backup.mts` summarizes the latest snapshot (users, exams, lecture status).
- **Restore** into an empty volume: `DATA_DIR=/data npx tsx scripts/restore-backup.mts [YYYY-MM-DD]` (run it inside the service). It restores the database and PDFs, then re-renders the slide images.

## Deploy

Live at https://dental-study-production.up.railway.app (Railway project "truthful-education").

- Every push to `main` on GitHub deploys automatically.
- All data (database, PDFs, slide images) lives on the Railway volume mounted at `/data` (`DATA_DIR=/data`). Nothing is stored in Git.
- Service variables (all listed with comments in `.env.example`):
  - `APP_PASSCODE`: the passcode everyone types before signing in.
  - `SECRET_KEY`: signs logins and encrypts saved API keys. Never change it once users exist, or saved API keys can't be decrypted.
  - `DATA_DIR`: `/data`, the volume.
  - Optional: `CLAUDE_MODEL`, `OPENAI_MODEL`, `CLAUDE_QUALITY_MODEL`, `OPENAI_QUALITY_MODEL` (model choices), `QUIZ_JUDGE` (`0` skips the second check of new quiz questions; leave it unset), and the backup bucket: `BACKUP_S3_ENDPOINT`, `BACKUP_S3_BUCKET`, `BACKUP_S3_REGION`, `BACKUP_S3_ACCESS_KEY_ID`, `BACKUP_S3_SECRET_ACCESS_KEY`.
  - `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` are only for a local test script; the site uses each student's own key. Don't set `NODE_ENV` or `NEXT_RUNTIME`; Next.js sets them.
- The site refuses to start in production if `APP_PASSCODE` or `SECRET_KEY` is empty or `DATA_DIR` is missing or not a full path (starting with `/`); the deploy log then names what is missing.

To host somewhere else, use a server with a persistent disk (Render and Fly.io also work). Point `DATA_DIR` at the disk, run `npm run build`, then `npm start`.

## Handoff for maintainers

Start with [docs/HANDOFF.md](docs/HANDOFF.md): what the project is and its goal, where it runs, the owner's working rules, the code map, everything shipped so far, decisions already taken and open items.
