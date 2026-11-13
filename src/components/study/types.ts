import type { CropBox } from "../SlideImage";

/**
 * A section of the topic map, with where it sits: its lecture (`lectureId` null for an old-style topic mapped across
 * lectures), the lecture's number and name, and the section's number among the lecture's `sections`.
 */
export type TopicLite = {
  id: number;
  position: number;
  title: string;
  emphasized: boolean;
  lectureId: number | null;
  lectureNo: number | null;
  lecture: string;
  section: number;
  sections: number;
};
export type LessonData = {
  topic: { id: number; title: string; emphasized: boolean };
  concepts: { id: number; name: string; mastery: number | null; earlier_exams: string[] }[];
  lesson: {
    intro: string;
    slides: { page_id: number; explanation: string }[];
    key_points: string[];
    connections: string | null;
  };
  aspects: Record<number, number>;
  /** Every slide of the section: its number and lecture (shown above the picture) and whether she emphasized it in her notes. */
  slideInfo?: Record<number, { number: number; lecture: string; emphasized: boolean }>;
  stressed?: { page_id: number; where: string; point: string }[];
};
export type QuizQ = {
  id?: string;
  question: string;
  options: string[];
  correct_index: number;
  explanation: string;
  /** One line per option (same order): why right / why wrong. Quizzes written before version 3 have none. */
  option_notes?: string[];
  concept: string;
  /** The picture the question is about, if any: shown cropped to the clinical image until answered, then whole. */
  image?: { page_id: number; aspect: number; crop: CropBox | null } | null;
  /** Reported earlier: skipped. Its place in the list (and the answer numbering) stays. */
  hidden?: boolean;
};
