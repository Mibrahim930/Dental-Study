// PDF page rendering, shared by uploads, backup restore and scripts. No database imports.
import * as mupdf from "mupdf";

const IMAGE_WIDTH = 1280;

export function openPdf(bytes: Buffer | Uint8Array): mupdf.Document {
  return mupdf.Document.openDocument(bytes, "application/pdf");
}

/**
 * A slide rendered as a 1280px-wide JPEG, plus its text layer and aspect ratio.
 * The page and its bitmap live in MuPDF's own memory, which JavaScript's garbage collector can't see, so they are
 * freed here explicitly: without that, a long lecture (150+ slides) grew the server by several MB per slide.
 */
export function renderPage(doc: mupdf.Document, index: number): { jpeg: Uint8Array; text: string; aspect: number } {
  const page = doc.loadPage(index);
  try {
    const [x0, y0, x1, y1] = page.getBounds();
    const scale = IMAGE_WIDTH / (x1 - x0);
    const pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true);
    let jpeg: Uint8Array;
    try {
      jpeg = pix.asJPEG(72);
    } finally {
      pix.destroy();
    }
    const structured = page.toStructuredText("preserve-whitespace");
    let text: string;
    try {
      text = structured.asText().trim();
    } finally {
      structured.destroy();
    }
    return { jpeg, text, aspect: (x1 - x0) / (y1 - y0) };
  } finally {
    page.destroy();
  }
}
