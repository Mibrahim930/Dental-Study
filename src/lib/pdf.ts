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

/** Pictures over this many pixels are refused before decoding (40 MP: well above any phone photo; decoding costs ~2.3 bytes per pixel). */
export const MAX_IMAGE_PIXELS = 40_000_000;

export class ImageTooLarge extends Error {
  constructor(width: number, height: number) {
    super(`That picture is ${width}×${height} pixels, which is too large to read here. Take a screenshot of it instead.`);
  }
}

/** Width and height from a PNG or JPEG header without decoding it; null for other kinds or a header we can't read. */
export function imageDimensions(bytes: Uint8Array, kind: UploadKind): { width: number; height: number } | null {
  const b = bytes;
  const u32 = (i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
  const u16 = (i: number) => (b[i] << 8) | b[i + 1];
  if (kind === "png") return b.length >= 24 ? { width: u32(16), height: u32(20) } : null;
  if (kind === "jpeg") {
    // Walk the segments to the first start-of-frame marker (C0–C3, C5–C7, C9–CB, CD–CF), which carries height then width.
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1];
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01 || marker === 0xff) {
        i += marker === 0xff ? 1 : 2;
        continue;
      }
      const len = u16(i + 2);
      if (len < 2) return null;
      const sof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (sof) return { width: u16(i + 7), height: u16(i + 5) };
      if (marker === 0xda || marker === 0xd9) return null; // scan data or end before any frame header
      i += 2 + len;
    }
    return null;
  }
  return null;
}

const IMAGE_MIME: Partial<Record<UploadKind, string>> = { jpeg: "image/jpeg", png: "image/png", gif: "image/gif", bmp: "image/bmp", tiff: "image/tiff" };

/**
 * A photo or screenshot as a JPEG no bigger than `maxSide` pixels on its long side (the AI reads JPEG; phone photos are
 * often 4000+ px and several MB). Throws for formats MuPDF can't decode (HEIC, WebP): check sniffFile first.
 */
export function imageToJpeg(bytes: Uint8Array, kind: UploadKind, maxSide = 1600): Uint8Array {
  const mime = IMAGE_MIME[kind];
  if (!mime) throw new Error(`Can't decode ${kind} images`);
  // A small file can still be a huge picture (a 400-megapixel PNG is 400 KB): refuse before MuPDF decodes it.
  const dims = imageDimensions(bytes, kind);
  if (dims && dims.width * dims.height > MAX_IMAGE_PIXELS) throw new ImageTooLarge(dims.width, dims.height);
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
