// PDF page rendering, shared by uploads, backup restore and scripts. No database imports.
import * as mupdf from "mupdf";

const IMAGE_WIDTH = 1280;

export function openPdf(bytes: Buffer | Uint8Array): mupdf.Document {
  return mupdf.Document.openDocument(bytes, "application/pdf");
}

export type UploadKind = "pdf" | "jpeg" | "png" | "gif" | "bmp" | "tiff" | "heic" | "webp" | "unknown";

/** What a file really is, from its first bytes (not its name, which phones and email apps often get wrong). */
export function sniffFile(bytes: Uint8Array): UploadKind {
  const b = bytes;
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  if (b.length >= 5 && ascii(0, 5) === "%PDF-") return "pdf";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b.length >= 8 && b[0] === 0x89 && ascii(1, 4) === "PNG") return "png";
  if (b.length >= 4 && ascii(0, 4) === "GIF8") return "gif";
  if (b.length >= 2 && ascii(0, 2) === "BM") return "bmp";
  if (b.length >= 4 && (ascii(0, 4) === "II*\0" || ascii(0, 4) === "MM\0*")) return "tiff";
  if (b.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "webp";
  if (b.length >= 12 && ascii(4, 8) === "ftyp" && /^(heic|heix|hevc|hevx|heim|heis|mif1|msf1|avif)$/.test(ascii(8, 12))) return "heic";
  return "unknown";
}

const IMAGE_MIME: Partial<Record<UploadKind, string>> = { jpeg: "image/jpeg", png: "image/png", gif: "image/gif", bmp: "image/bmp", tiff: "image/tiff" };

/**
 * A photo or screenshot as a JPEG no bigger than `maxSide` pixels on its long side (the AI reads JPEG; phone photos are
 * often 4000+ px and several MB). Throws for formats MuPDF can't decode (HEIC, WebP): check sniffFile first.
 */
export function imageToJpeg(bytes: Uint8Array, kind: UploadKind, maxSide = 1600): Uint8Array {
  const mime = IMAGE_MIME[kind];
  if (!mime) throw new Error(`Can't decode ${kind} images`);
  const doc = mupdf.Document.openDocument(bytes, mime);
  try {
    const page = doc.loadPage(0);
    try {
      const [x0, y0, x1, y1] = page.getBounds();
      const scale = Math.min(3, maxSide / Math.max(x1 - x0, y1 - y0, 1));
      const pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true);
      try {
        return pix.asJPEG(80);
      } finally {
        pix.destroy();
      }
    } finally {
      page.destroy();
    }
  } finally {
    doc.destroy();
  }
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
