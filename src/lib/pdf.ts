// PDF page rendering, shared by uploads, backup restore and scripts. No database imports.
import * as mupdf from "mupdf";

const IMAGE_WIDTH = 1400;

export function openPdf(bytes: Buffer | Uint8Array): mupdf.Document {
  return mupdf.Document.openDocument(bytes, "application/pdf");
}

/** A slide rendered as a 1400px-wide JPEG, plus its text layer and aspect ratio. */
export function renderPage(doc: mupdf.Document, index: number): { jpeg: Uint8Array; text: string; aspect: number } {
  const page = doc.loadPage(index);
  const [x0, y0, x1, y1] = page.getBounds();
  const scale = IMAGE_WIDTH / (x1 - x0);
  const pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true);
  return {
    jpeg: pix.asJPEG(80),
    text: page.toStructuredText("preserve-whitespace").asText().trim(),
    aspect: (x1 - x0) / (y1 - y0),
  };
}
