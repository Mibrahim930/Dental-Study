// What Claude extracts from each slide. No database imports, so scripts can use it standalone.
import { z } from "zod";

export const SlideNotes = z.object({
  title: z.string().describe("Short title for the slide"),
  summary: z.string().describe("1-2 sentence plain-language summary of what this slide teaches"),
  image_description: z
    .string()
    .nullable()
    .describe("What the radiographs / photos / histology / diagrams show and what to notice. null if no meaningful image"),
  key_facts: z.array(z.string()).describe("Testable facts from this slide, each one self-contained"),
  annotations: z
    .array(z.string())
    .describe("Notes the student or professor added on top of the slide: typed notes, handwriting, circled/highlighted text. Transcribe them"),
  emphasized: z
    .boolean()
    .describe("True if the slide or its annotations flag this as important/high-yield/'will be on the exam'"),
  case_prompt: z
    .string()
    .nullable()
    .describe("If the slide presents a patient case or image and asks for diagnosis/treatment, the question it asks. Otherwise null"),
  case_answer: z.string().nullable().describe("The answer to case_prompt if shown on the slide, spelled out. Otherwise null"),
  case_image_box: z
    .object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
    .nullable()
    .describe(
      "When case_prompt is set: the region (fractions 0-1 of slide width/height, origin top-left) that contains ONLY the clinical images (radiographs/photos), excluding the question text and any label that reveals the answer. If an answer-revealing label or handwritten note sits inside the image itself (so no rectangle can exclude it), return null. Otherwise null",
    ),
  abbreviations: z.array(z.object({ abbr: z.string(), meaning: z.string() })),
  concepts: z.array(z.string()).describe("2-5 short canonical dental concept names this slide covers"),
  is_filler: z.boolean().describe("True for title, agenda, objectives-only, references, or thank-you slides"),
});
export type SlideNotes = z.infer<typeof SlideNotes>;

export const NOTES_SYSTEM = `You are turning a dental school lecture slide into study notes for a dental student.
You get the rendered slide image plus the slide's extracted text layer.
Much of the meaning is in the images (radiographs, clinical photos, histology) and in small labels such as diagnosis abbreviations, so read the image carefully.
The PDF may contain the student's own annotations (typed notes at the top of the slide or handwriting on it); transcribe them into "annotations".
Spell out dental abbreviations (e.g. SIP = symptomatic irreversible pulpitis, PN = pulp necrosis, AAA = acute apical abscess) using standard AAE terminology.
Stay faithful to the slide. Do not add facts that are not on the slide or directly implied by it.`;
