# Dental Study

A study tool for dental students, built around their own lecture PDFs. Many students can use one site: each has their own account, data and AI key.

- **Access:** a site passcode, then email + password accounts. Each user adds their own **Claude or ChatGPT API key** (stored encrypted) and pays for their own usage. There's a step-by-step guide at `/help/api-keys`.
- **Exam workspaces:** upload lecture PDFs. Every slide (images, radiographs, handwritten notes) is read once by AI. Claude users go through the Batch API at half price.
- **Topic map, study sessions with tutor chat, practice exams (recall / INBDE-style case / image), daily spaced review, progress.**
- **Memory across exams:** each user's concept mastery, slide library and session summaries carry over from one exam to the next.
- **Spending tracker:** Settings shows each user's estimated AI spend.

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

## Deploy

Live at https://dental-study-production.up.railway.app (Railway project "truthful-education").

- Every push to `main` on GitHub deploys automatically.
- All data (database, PDFs, slide images) lives on the Railway volume mounted at `/data` (`DATA_DIR=/data`). Nothing is stored in Git.
- Service variables: `APP_PASSCODE`, `SECRET_KEY` (never change it once users exist, or saved API keys can't be decrypted), `DATA_DIR`.

To host somewhere else, use a server with a persistent disk (Render and Fly.io also work). Point `DATA_DIR` at the disk, run `npm run build`, then `npm start`.
