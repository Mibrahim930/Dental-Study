// Writing iCalendar (RFC 5545) text for the phone-calendar feed. Pure helpers, no database.

/** TEXT value escaping (RFC 5545 §3.3.11): backslash, semicolon, comma and newlines. */
export function icsEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r\n|\r|\n/g, "\\n");
}

const encoder = new TextEncoder();

/**
 * Fold a content line so no physical line is longer than 75 octets (RFC 5545 §3.1). Continuation lines start with one
 * space, which counts toward their 75. Never splits a multi-byte UTF-8 character (emoji, accents).
 */
export function foldLine(line: string): string {
  if (encoder.encode(line).length <= 75) return line;
  const out: string[] = [];
  let current = "";
  let bytes = 0;
  let limit = 75;
  for (const ch of line) {
    const size = encoder.encode(ch).length;
    if (bytes + size > limit) {
      out.push(current);
      current = "";
      bytes = 0;
      limit = 74; // the leading space of the continuation line takes one octet
    }
    current += ch;
    bytes += size;
  }
  out.push(current);
  return out.join("\r\n ");
}

/** Join content lines into a calendar body: every line folded, CRLF line ends, trailing CRLF. */
export function icsBody(lines: string[]): string {
  return lines.map(foldLine).join("\r\n") + "\r\n";
}

export const compactDate = (d: string) => d.replaceAll("-", "");

/** BYDAY codes, Monday first (matches planner weekday(): 0 = Monday). */
export const ICS_DAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
