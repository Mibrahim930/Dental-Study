# Dental Study

A study tool for dental students, built around their own lecture PDFs.

- **Exam workspaces:** one per exam. Upload the lectures, and every slide (including images, radiographs and the student's handwritten notes) is read by Claude and turned into notes.
- **Topic map:** slides are grouped into an ordered list of topics. Each concept shows the student's mastery and whether an earlier exam already covered it.
- **Study sessions:** a guided walkthrough of each topic (explanation, the key slides, key points, quick checks), with a tutor chat beside it. When a session ends, a short summary is saved so the next session picks up where it left off.
- **Practice exams:** recall, INBDE-style case, and image questions built from the slides. Tutor or timed mode. Every question cites its source slide, and the student can report errors.
- **Shared memory across exams:** concept mastery, every uploaded slide (searchable) and session summaries carry over from one exam to the next. Missed questions go into a spaced-repetition daily review.

## Run it locally

1. Install [Node.js](https://nodejs.org) 20 or newer.
2. `npm install`
3. Copy `.env.example` to `.env.local` and fill in:
   - `ANTHROPIC_API_KEY`: your key from console.anthropic.com
   - `APP_PASSCODE`: the passcode the student will type (leave empty to skip the login screen locally)
4. `npm run dev` and open http://localhost:3000

All data lives in `./data`: the SQLite database, the uploaded PDFs and the rendered slide images. Back up that folder to keep the student's progress.

## Costs

Every Claude call uses `claude-opus-5-5` by default (set `AI_MODEL` to change it).

- **Uploading:** each slide is read once with vision, at a few cents per slide. A 500-slide exam costs roughly $5–10, paid once.
- **Studying:** each topic's lesson is generated once and cached. Tutor chat and practice exams cost a few cents per message or question batch.

## Deploy

The app needs a server with a persistent disk, because it stores SQLite and the image files on disk. Railway, Render and Fly.io all work. Mount a volume, set `DATA_DIR` to it, set the env vars above, then build with `npm run build` and start with `npm start`.
