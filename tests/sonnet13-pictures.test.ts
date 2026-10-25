// Sonnet QA 13: picture detector false positives / negatives, pictureFor with stems, judge backstop, repair.
import { beforeEach, describe, expect, it, vi } from "vitest";

type QuizOut = { slot: number; question: string; options: string[]; correct_index: number; correct_answer: string; explanation: string; source_page_id: number; image_page_id: number | null; concept: string };
let quizWriter: (slots: { n: number; page: number }[]) => QuizOut[] = () => [];
let judgePicture: (question: string) => boolean = () => false;
vi.mock("@/lib/ai", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai")>()),
  generate: vi.fn(async (opts: { purpose: string; content: string }) => {
    if (opts.purpose === "section quiz") {
      const slots = [...opts.content.matchAll(/^Q(\d+): slide P(\d+)/gm)].map((m) => ({ n: Number(m[1]), page: Number(m[2]) }));
      return { questions: quizWriter(slots) };
    }
    if (opts.purpose === "section quiz check") {
      const stems = [...opts.content.matchAll(/^\d+\. (.*)$/gm)].map((m) => m[1]);
      return { verdicts: stems.map((t, i) => ({ n: i + 1, ok: true, picture: judgePicture(t), reason: "" })) };
    }
    throw new Error("unexpected " + opts.purpose);
  }),
}));
vi.mock("@/lib/credentials", async (orig) => ({
  ...(await orig<typeof import("@/lib/credentials")>()),
  credentials: (userId: number) => ({ userId, provider: "anthropic", apiKey: "k" }),
}));

import { db, type Topic } from "@/lib/db";
import { getSectionQuiz, type QuizQuestion } from "@/lib/study";
import { mentionsPicture, pictureFor, repairPictureQuestions } from "@/lib/questionImage";
import { makeUser } from "./helpers";

const notes = (image: string | null = null) =>
  JSON.stringify({ title: "t", summary: "s", image_description: image, key_facts: ["a", "b"], annotations: [], emphasized: false, emphasis_note: null, case_prompt: null, case_answer: null, case_image_box: null, abbreviations: [], concepts: [], is_filler: false });

function world() {
  const userId = makeUser();
  const examId = Number(db.prepare("INSERT INTO exams (user_id, name, topic_status) VALUES (?, 'E', 'ready')").run(userId).lastInsertRowid);
  const mkDoc = (n: string) => Number(db.prepare("INSERT INTO documents (exam_id, filename, status) VALUES (?, ?, 'done')").run(examId, n).lastInsertRowid);
  const d1 = mkDoc("L1.pdf");
  const d2 = mkDoc("L2.pdf");
  const ins = db.prepare("INSERT INTO pages (document_id, page_number, image_path, aspect, status, notes_json) VALUES (?, ?, 'x.jpg', 1.5, 'done', ?)");
  const ids: number[] = [];
  for (let i = 1; i <= 3; i++) ids.push(Number(ins.run(d1, i, notes(i === 2 ? "A periapical radiograph" : null)).lastInsertRowid));
  const l2s1 = Number(ins.run(d2, 1, notes()).lastInsertRowid); // L2 slide 1: same number as L1 slide 1
  const topicId = Number(db.prepare("INSERT INTO topics (exam_id, position, title, summary, page_ids) VALUES (?, 0, 'T', '', ?)").run(examId, JSON.stringify([...ids, l2s1])).lastInsertRowid);
  db.prepare("INSERT INTO study_sessions (exam_id) VALUES (?)").run(examId);
  const topic = () => db.prepare("SELECT * FROM topics WHERE id = ?").get(topicId) as Topic;
  const rows = () => db.prepare("SELECT id, aspect, notes_json, page_number FROM pages WHERE id IN (" + [...ids, l2s1].join(",") + ")").all() as { id: number; aspect: number; notes_json: string; page_number: number }[];
  return { userId, examId, topicId, topic, p1: ids[0], p2: ids[1], p3: ids[2], l2s1, rows };
}
const q = (slot: number, page: number, text: string, image: number | null): QuizOut => ({ slot, question: text, options: ["right", "w1", "w2", "w3"], correct_index: 0, correct_answer: "right", explanation: "because", source_page_id: page, image_page_id: image, concept: "C" });

beforeEach(() => {
  quizWriter = () => [];
  judgePicture = () => false;
});

// Realistic text-only stems. Every one should be false.
const TEXT_ONLY = [
  "Which of the following is the correct outline form for a Class I amalgam preparation?",
  "The outline form of an MO inlay is extended to include what?",
  "A patient's chart shows a history of anaphylaxis to penicillin. Which antibiotic is appropriate?",
  "Per the patient chart, the last bitewings were taken 2 years ago. What is the next step?",
  "When drawing the flap, the incision should be made where?",
  "Drawing blood from the antecubital fossa risks injury to which nerve?",
  "The figure 35% refers to what proportion of patients with dry socket?",
  "A figure of 5 mm is the threshold for what?",
  "The gingiva appears red and edematous. Which diagnosis is most likely?",
  "The mucosa appears white in a wrinkled pattern. What is the likely lesion?",
  "The tissue appears red and shiny in the area. What is the most likely cause?",
  "Which bracket prescription has 22 degrees of torque on the maxillary central incisor?",
  "Bonding a bracket to a tooth with hypoplastic enamel requires what?",
  "The orthodontic bracket slot size most commonly used with 0.018 inch is?",
  "Which numbering system labels the maxillary right third molar as 1?",
  "In the FDI system, teeth are numbered by quadrant. What is #11?",
  "Which burs are numbered 556 and 557?",
  "Rubber dam clamp number 212 is used on which tooth?",
  "The file is marked with a stopper at the working length. Why?",
  "Which instrument is marked with millimeter bands at 3, 6, 9 and 11 mm?",
  "The Williams probe is marked at 1, 2, 3, 5, 7, 8, 9 and 10 mm. True or false?",
  "A pocket depth of 6 mm and bleeding on probing is most consistent with what stage?",
  "The recommended dose of amoxicillin for prophylaxis is what?",
  "The circle of Willis supplies which part of the brain?",
  "A circle-shaped radiolucency is typical of which lesion?",
  "Which muscles form the boundary of the pterygomandibular space?",
  "The slide valve in a handpiece controls what?",
  "When the clinician slides the explorer along the root, what is felt at a calculus ledge?",
  "The patient slides forward in the chair during treatment. What should be done?",
  "The mandible slides forward in protrusion. Which muscle is responsible?",
  "In a sliding genioplasty, the chin is moved by what?",
  "An arrowhead restoration is another name for what?",
  "The treatment planning sequence begins with which phase?",
  "A graph of dose-response is sigmoidal for most drugs. What does the plateau represent?",
  "What does the dose-response curve indicate about drug potency?",
  "Which type of radiograph has the highest resolution for caries detection?",
  "Radiographic examination of a 6-year-old requires which films?",
  "Which radiograph shows the entire mandible in one exposure?",
  "A panoramic radiograph distorts which dimension most?",
  "The kVp setting affects what aspect of the radiographic image?",
  "Film density increases with increased mAs. True or false?",
  "Image receptors in digital radiography include which of the following?",
  "Which of the following best describes the inverse square law?",
  "A patient has a shaded history of smoking. What is the periodontal risk?",
  "The color of the gingiva in a healthy patient is described as what?",
  "The teeth are labeled by the Palmer notation using brackets. Which quadrant is the upper right?",
  "Clinically, a necrotic pulp shows what response to cold?",
  "Which stain is used to highlight Gram-positive organisms?",
  "H&E stain colors nuclei blue. What color does it stain collagen?",
  "Which cement is marked by a long working time and fluoride release?",
  "A glass ionomer is indicated for which restoration?",
  "The patient is shown the shade guide and picks A2. What is the shade of A2?",
  "Studies have shown that fluoride varnish reduces caries by what percent?",
  "It has been shown that chlorhexidine reduces plaque by what mechanism?",
  "Which of the following is seen in Sjogren syndrome?",
  "Which findings are seen in a patient with hyperparathyroidism?",
  "A lesion seen in the floor of the mouth that is bluish is likely what?",
  "Which nerve is visible in the surgical field during third molar extraction?",
  "Highlighted in the ADA guidelines is the use of what for caries prevention?",
  "Which line angle is formed by the junction of the mesial and facial surfaces?",
  "The cervical line curves more toward the incisal on which surface?",
  "In the tooth preparation for a crown, the finish line is placed where?",
  "Which denture border is determined by the red line of the lip?",
  "The vermilion border is the junction of what?",
  "The red zone of the lip is called what?",
  "The white line in the buccal mucosa at the occlusal plane is called what?",
  "A patient presents with linea alba. What is the cause?",
  "Pictures of the patient's smile are used to evaluate what in esthetic planning?",
  "A photographic record is part of the initial exam. Which view is standard?",
  "The cephalometric analysis uses which landmark as the origin?",
  "Which landmark on a lateral ceph is Point A?",
  "The rule of thumb for the dose of local anesthetic is what?",
  "Epinephrine in a 1:100,000 solution contains how many mg/mL?",
  "The maximum dose of lidocaine with epi is 7 mg/kg. True or false?",
  "The graphite in a pencil leaves what mark on articulating paper?",
  "Graph paper is used for tracing. Which structures are traced first?",
  "A Class II division 2 malocclusion is characterized by what?",
  "The reciprocal arm of a clasp is placed where?",
  "Indicated lab tests for a bleeding disorder include which?",
  "Which of the following is indicated for a patient allergic to amides?",
  "On the day of surgery, the patient should be NPO for how long?",
  "On the first visit, which radiographs are taken?",
  "From the history, the patient reports a dull ache that lingers. Diagnosis?",
  "In the maxillary arch, which tooth has the longest root?",
  "In the mandibular arch, the lingual tori are found where?",
  "Slide the retractor under the periosteum. Which instrument is it?",
  "A wedge is placed. Which of the following is the purpose of the wedge?",
  "The patient has a 5 mm pocket labeled as moderate by the clinician. What stage?",
  "A tooth is numbered 8 in the Universal system. Which is it?",
];

// Realistic picture stems. Every one should be true.
const PICTURE = [
  "Using the radiograph provided, which tooth has the periapical radiolucency?",
  "The arrow points to which anatomical structure?",
  "In this clinical photo, what is the most likely diagnosis?",
  "On slide 12, which structure is the clasp assembly?",
  "Per the schematic, which path does the beam take?",
  "Which of the structures labeled A through E is the mandibular canal?",
  "Which structure is indicated by the arrow?",
  "The tooth in the radiograph below has which type of resorption?",
  "Look at the photograph. What is the shade?",
  "What is the name of the instrument in the picture?",
  "Refer to the radiograph. Which canal system is present?",
  "The lesion shown in the panoramic image is most consistent with what?",
  "What is the radiolucency at the apex shown here?",
  "Based on the clinical image, what is the periodontal diagnosis?",
  "The structure labeled 3 is which?",
  "Which muscle is labeled B?",
  "Which part is highlighted in yellow?",
  "What kind of bone loss is shown in this image?",
  "What does the figure show?",
  "On the schematic, which line represents the occlusal plane?",
  "What does the X in the figure indicate?",
  "The image depicts which developmental anomaly?",
  "The structure pointed to by the arrow is supplied by which nerve?",
  "From the photo, what is the Angle classification?",
  "In the illustration, the structure at the top is which?",
  "In the diagram of the pulp, which layer is the odontoblastic layer?",
  "This radiograph demonstrates which stage of root development?",
  "What is shown in the clinical photograph?",
];

// Plain text stems the detector wrongly calls pictures. A false positive deletes a stored practice question (or hides a quiz one).
const BUG_FALSE_POSITIVE = [
  "Venous blood is drawn into which tube for INR?",
  "Medical history: blood pressure is measured and blood is drawn. Which value matters?",
  "Saliva is drawn into the suction tip by what?",
  "The local anesthetic is drawn into the syringe before the cartridge is seated. What is wrong?",
  "The line is drawn from nasion to point A on the tracing. What does it represent?",
  "The Frankfort plane is drawn from porion to orbitale. True or false?",
  "The incision is drawn from the distal of the second molar anteriorly. What is the name of the flap?",
  "Blood is drawn from the patient before surgery. Which lab value assesses extrinsic coagulation?",
  "Examine the patient's chart. What is the next step?",
  "See the patient's chart. Which allergy is listed?",
  "In the patient's chart, which entry is a legal requirement?",
  "On the periapical radiograph of a healthy tooth, the PDL space appears how?",
  "Each arrow clasp is placed in which embrasure?",
  "The surface labeled D in Black's notation is what?",
  "The patient is marked A on the ASA scale. Which is it?",
  "Risk factors are highlighted by the risk assessment form. Which one is the strongest?",
];
// Picture stems the detector misses. Quizzes have the judge as a backstop; practice exams do not.
const BUG_FALSE_NEGATIVE = [
  "Identify the lesion shown.",
  "What is the diagnosis for the lesion pictured?",
  "What is the appropriate treatment for the case pictured?",
  "What is the restoration shown on tooth #30?",
  "What is the name of the clasp illustrated?",
  "What structure is at the tip of the pointer?",
  "Which letter marks the mental foramen?",
  "Which letter represents the lingual cusp?",
  "Identify the numbered structure.",
  "Name the structure indicated by the number 4.",
  "The structure marked with an asterisk is which?",
  "The bitewing above shows which type of caries?",
  "What is the lesion in the panoramic radiograph?",
  "Which of the following describes the radiograph?",
  "Which of the following is visible on this film?",
  "Which pathology is demonstrated in this film?",
  "In the photomicrograph, what cell type is seen?",
  "The CBCT slice shows which finding?",
  "The area enclosed in the box is which structure?",
  "Which landmark is indicated by the red dot on the cephalogram?",
  "The arrowhead indicates which structure?",
];
// Rare wording that currently counts as a picture; documented, not asserted as bugs.
const LOW_RISK_FALSE_POSITIVE = [
  "An illustration of the principle of ALARA is that dose should be what?",
  "Schematic forms of treatment planning start with what?",
  "Which arrow-shaped lesion is characteristic of herpangina?",
  "The patient is circled by concern about cost. How should the dentist respond?",
  "Which type of clasp arm is circled by a rigid retentive design?",
  "Which fibers are drawn into the cementum as Sharpey's fibers?",
  "Which drug is highlighted in the guidelines for infective endocarditis prophylaxis?",
  "The pulp tissue is highlighted by which stain in histologic sections?",
  "The ledge is outlined by the dentist as a risk. What should be done?",
  "On the slide valve, what is the function?",
  "Dental flow chart for caries management: which is the first step?",
];

describe("detector precision and recall", () => {
  it("lists are large enough", () => {
    expect(TEXT_ONLY.length + BUG_FALSE_POSITIVE.length).toBeGreaterThanOrEqual(60);
    expect(PICTURE.length + BUG_FALSE_NEGATIVE.length).toBeGreaterThanOrEqual(30);
  });
  it.each(TEXT_ONLY)("text stays text: %s", (t) => {
    expect(mentionsPicture(t)).toBe(false);
  });
  it.each(PICTURE)("picture is picture: %s", (t) => {
    expect(mentionsPicture(t)).toBe(true);
  });
  // Fixed (was BUG): ordinary prose stays text in BOTH modes (the repair deletes on a false positive; the writers would attach a slide).
  it.each(BUG_FALSE_POSITIVE)("text stays text, strict and generous: %s", (t) => {
    expect(mentionsPicture(t)).toBe(false);
    expect(mentionsPicture(t, "generous")).toBe(false);
  });
  // Fixed (was BUG): the writers use the generous mode, so these picture stems get their picture.
  it.each(BUG_FALSE_NEGATIVE)("picture is picture in generous mode: %s", (t) => {
    expect(mentionsPicture(t, "generous")).toBe(true);
  });
  it.each(TEXT_ONLY)("text stays text in generous mode too: %s", (t) => {
    expect(mentionsPicture(t, "generous")).toBe(false);
  });
  // Was "documented: rare wording counts as picture"; after the split these read as the text they are.
  it.each(LOW_RISK_FALSE_POSITIVE)("rare wording now stays text: %s", (t) => {
    expect(mentionsPicture(t)).toBe(false);
    expect(mentionsPicture(t, "generous")).toBe(false);
  });
});

describe("pictureFor with stems", () => {
  it("slide number matching exactly one page wins; ambiguous number falls back to the source", () => {
    const w = world();
    const rows = w.rows();
    expect(pictureFor(rows, null, w.p1, "On slide 2's radiograph, where is the lesion?")?.page_id).toBe(w.p2);
    // slide 1 exists in two lectures: ambiguous, so the source (p3, unmarked, whole) is used
    expect(pictureFor(rows, null, w.p3, "On slide 1's diagram, what is drawn?")?.page_id).toBe(w.p3);
    // named wins over number
    expect(pictureFor(rows, w.p2, w.p1, "On slide 3's diagram, what is drawn?")?.page_id).toBe(w.p2);
  });
  it("invalid named id and unmarked source: whole source slide for a picture stem, nothing without a stem", () => {
    const w = world();
    const rows = w.rows();
    expect(pictureFor(rows, 999999, w.p1, "In the figure, what is marked?")?.page_id).toBe(w.p1);
    expect(pictureFor(rows, 999999, w.p1)).toBeNull();
    expect(pictureFor(rows, 999999, null, "In the figure")).toBeNull();
  });
  it("a scoped page list cannot pull a slide outside the scope", () => {
    const w = world();
    const scoped = w.rows().filter((p) => p.id !== w.p2);
    expect(pictureFor(scoped, null, w.p1, "On slide 2's radiograph, where is the lesion?")?.page_id).toBe(w.p1);
    expect(pictureFor(scoped.filter((p) => p.id === w.p3), null, null, "On slide 2's radiograph, where?")).toBeNull();
  });
  it("a page list without page_number does not throw on a numbered stem", () => {
    const w = world();
    const bare = w.rows().map((p) => ({ id: p.id, aspect: p.aspect, notes_json: p.notes_json }));
    expect(pictureFor(bare, null, w.p1, "On slide 2's radiograph?")?.page_id).toBe(w.p1);
  });
});

describe("judge backstop", () => {
  it("picture:true on a regex-text question with an unmarked source slide attaches the whole slide (judge runs once; the attached slide is not re-judged for answer leakage)", async () => {
    const w = world();
    quizWriter = (slots) => slots.map((s, i) => (i === 0 ? q(s.n, w.p1, "Which tooth carries the rest seat?", null) : q(s.n, s.page, `Plain question ${s.n}`, null)));
    judgePicture = (t) => t.startsWith("Which tooth carries");
    const quiz = await getSectionQuiz(w.topic());
    expect(quiz.find((x) => x.question.startsWith("Which tooth carries"))?.image_page_id).toBe(w.p1);
  });
  it("picture:true with no usable source slide drops the question", async () => {
    const w = world();
    quizWriter = (slots) => slots.map((s, i) => (i === 0 ? q(s.n, 999999, "Which tooth carries the rest seat?", null) : q(s.n, s.page, `Plain question ${s.n}`, null)));
    judgePicture = (t) => t.startsWith("Which tooth carries");
    const quiz = await getSectionQuiz(w.topic());
    expect(quiz.find((x) => x.question.startsWith("Which tooth carries"))).toBeUndefined();
  });
});

describe("repairPictureQuestions with the new rules", () => {
  it("keeps outline-form text, gives slide 3's diagram slide 3, leaves hidden quiz entries alone, idempotent", () => {
    const w = world();
    const insQ = db.prepare("INSERT INTO questions (exam_id, topic_id, type, stem, options, correct_index, explanation, source_page_id) VALUES (?, ?, 'recall', ?, '[\"a\",\"b\"]', 0, 'e', ?)");
    const outline = Number(insQ.run(w.examId, w.topicId, "What determines the outline form of a Class II preparation?", w.p1).lastInsertRowid);
    const s3 = Number(insQ.run(w.examId, w.topicId, "On slide 3's diagram, the planes are drawn to show what?", w.p1).lastInsertRowid);
    const quiz = [
      { id: "aaaaaaaa", question: "In the figure, what is marked?", options: ["a", "b", "c", "d"], correct_index: 0, explanation: "e", concept: "C", source_page_id: w.p1, hidden: true, report_note: "mine" },
      { id: "bbbbbbbb", question: "Outline form question", options: ["a", "b", "c", "d"], correct_index: 0, explanation: "e", concept: "C", source_page_id: w.p1 },
    ];
    db.prepare("UPDATE topics SET checks_json = ?, checks_version = 2 WHERE id = ?").run(JSON.stringify(quiz), w.topicId);
    expect(repairPictureQuestions()).toBe(1);
    const row = (id: number) => db.prepare("SELECT image_page_id, flagged FROM questions WHERE id = ?").get(id) as { image_page_id: number | null; flagged: number } | undefined;
    expect(row(outline)).toEqual({ image_page_id: null, flagged: 0 });
    expect(row(s3)).toEqual({ image_page_id: w.p3, flagged: 0 });
    const after = JSON.parse(w.topic().checks_json!) as (QuizQuestion & { report_note?: string })[];
    expect(after[0].report_note).toBe("mine");
    expect(after[1].hidden).toBeUndefined();
    expect(repairPictureQuestions()).toBe(0);
  });
});
