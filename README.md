# Lolo's Study Buddy (Dental Study)

A study tool for dental students, built around their own lecture PDFs. Many students can use one site: each has their own account, data and AI key.

- **Access:** a site passcode, then email + password accounts. Each user adds their own **Claude or ChatGPT API key** (stored encrypted) and pays for their own usage. There's a step-by-step guide at `/help/api-keys`.
- **Exam workspaces:** upload lecture PDFs. Every slide (images, radiographs, handwritten notes) is read once by AI. Claude users go through the Batch API at half price.
- **Topic map, study sessions with tutor chat, practice exams (recall / INBDE-style case / image), daily spaced review, progress.**
- **Memory across exams:** each user's concept mastery, slide library and session summaries carry over from one exam to the next.
- **Spending tracker:** Settings shows each user's estimated AI spend.
- **Calendar and study planner:** year and month calendar with exams (each one is an exam workspace) and busy days. A paced day-by-day plan across all upcoming exams, "Today's plan" on the home page, tasks that tick themselves off, and a calendar subscription link for Google or Apple Calendar.
- **Practice:** recall, case, image, and **INBDE-style case sets** (one patient, 3–5 questions).
- **Classes:** invite codes, and shared exams classmates can add with no AI cost. Progress stays private, and a reported question is hidden class-wide.
- **Admin** (`/admin`, first account): users, password resets with a temporary password, account removal, spending, backup status.

## Run it locally

1. `npm install`
2. Copy `.env.example` to `.env.local` and set `APP_PASSCODE` and `SECRET_KEY` (`openssl rand -base64 32`).
3. `npm run dev`, then open http://localhost:3000, enter the passcode, create an account, and add an API key.

Data goes to `./data` (SQLite + PDFs + slide images) unless `DATA_DIR` is set.

## Models and costs

| | Claude (`claude-sonnet-5-5`) | ChatGPT (`gpt-6.1-sol`) |
|---|---|---|
| Reading a 500-slide exam (once) | ~$3 (batched, 50% off) | ~$6 |
| One topic lesson (generated once, cached) | ~2.5¢ | ~2.5¢ |
| Tutor message | ~1¢ (lecture context is prompt-cached) | ~1¢ |
| 10-question practice exam | ~10¢ | ~10¢ |

Measured on the Claude path with a real 53-slide lecture. The ChatGPT figures are estimates. Questions from abandoned or skipped practice exams are reused instead of being regenerated.

`CLAUDE_MODEL` and `OPENAI_MODEL` override the defaults.

## Tests

`npm test` runs the Vitest suite (planner, classes, auth, data isolation, spaced review, database upgrade). Each run uses a throwaway database.

## Backups and restore

- Every day the app copies a database snapshot (`db/study-YYYY-MM-DD.db.gz`, last 14 kept) and any new lecture PDFs (`pdfs/doc-<id>.pdf`) to the Railway bucket `dental-study-backups` (`BACKUP_S3_*` variables). Status and a "Back up now" button are on `/admin`.
- `railway run npx tsx scripts/list-backups.mts` lists what's stored.
- `railway run npx tsx scripts/inspect-backup.mts` summarizes the latest snapshot (users, exams, lecture status).
- **Restore** into an empty volume: `DATA_DIR=/data npx tsx scripts/restore-backup.mts [YYYY-MM-DD]` (run it inside the service). It restores the database and PDFs, then re-renders the slide images.

## Deploy

Live at https://dental-study-production.up.railway.app (Railway project "truthful-education").

- Every push to `main` on GitHub deploys automatically.
- All data (database, PDFs, slide images) lives on the Railway volume mounted at `/data` (`DATA_DIR=/data`). Nothing is stored in Git.
- Service variables: `APP_PASSCODE`, `SECRET_KEY` (never change it once users exist, or saved API keys can't be decrypted), `DATA_DIR`.

To host somewhere else, use a server with a persistent disk (Render and Fly.io also work). Point `DATA_DIR` at the disk, run `npm run build`, then `npm start`.
