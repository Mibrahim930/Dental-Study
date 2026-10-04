// Sends one slide to the AI and prints the notes. Nothing is saved.
//   npx tsx --env-file=.env.local scripts/test-slide.mts <pdf> <page> [anthropic|openai]
// Uses ANTHROPIC_API_KEY or OPENAI_API_KEY from the environment.
import fs from "fs";
import { generate } from "../src/lib/ai";
import { openPdf, renderPage } from "../src/lib/pdf";
import { NOTES_SYSTEM, SlideNotes } from "../src/lib/notes";

const [file, pageArg, providerArg] = process.argv.slice(2);
const provider = providerArg === "openai" ? "openai" : "anthropic";
const apiKey = (provider === "openai" ? process.env.OPENAI_API_KEY : process.env.ANTHROPIC_API_KEY) ?? "";
const { jpeg, text } = renderPage(openPdf(fs.readFileSync(file)), Number(pageArg) - 1);
const t0 = Date.now();
generate({
  creds: { userId: 0, provider, apiKey },
  purpose: "test",
  schema: SlideNotes,
  system: NOTES_SYSTEM,
  effort: "low",
  maxTokens: 8000,
  content: [
    { type: "image", base64: Buffer.from(jpeg).toString("base64") },
    { type: "text", text: `Lecture: test\nSlide ${pageArg}\n\nExtracted text layer:\n${text}` },
  ],
}).then((n) => console.log(JSON.stringify(n, null, 2), `\n${((Date.now() - t0) / 1000).toFixed(1)}s`));
