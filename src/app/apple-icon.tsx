import { ImageResponse } from "next/og";

// Phone home-screen icon. Full-bleed square: iOS rounds the corners itself.
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

const MARK = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#0E5E55"/><path d="M19 17c0-5.5 5-8 9.5-6.6 1.6.5 2.4 1.1 3.5 1.1s1.9-.6 3.5-1.1C40 9 45 11.5 45 17c0 6-1.7 10.3-2.7 15-1.3 6.3-2.3 14.6-4.6 19.4-1 2.1-3.1 1.8-3.5-.6l-1.3-9.6c-.2-1.6-1.6-1.6-1.8 0l-1.3 9.6c-.4 2.4-2.5 2.7-3.5.6-2.3-4.8-3.3-13.1-4.6-19.4C20.7 27.3 19 23 19 17z" fill="#B8F5E6"/><path d="M24.5 22c2.6-1.6 5.2-1.6 7.5.4 2.3-2 4.9-2 7.5-.4" fill="none" stroke="#0E5E55" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M32 22.4v5" fill="none" stroke="#0E5E55" stroke-width="2.2" stroke-linecap="round"/></svg>`;

export default function AppleIcon() {
  return new ImageResponse(
    // eslint-disable-next-line @next/next/no-img-element
    <img alt="" width={180} height={180} src={`data:image/svg+xml;base64,${Buffer.from(MARK).toString("base64")}`} />,
    size,
  );
}
