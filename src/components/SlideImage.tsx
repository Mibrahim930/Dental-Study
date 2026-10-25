/* eslint-disable @next/next/no-img-element */
export type CropBox = { x: number; y: number; width: number; height: number };

/**
 * A rendered slide. With `crop` (fractions of the slide), shows only that region —
 * used on image questions so answer labels printed on the slide stay hidden.
 */
export function SlideImage({ pageId, alt, aspect, crop }: { pageId: number; alt: string; aspect?: number; crop?: CropBox | null }) {
  const src = `/api/pages/${pageId}/image`;
  if (!crop || !aspect) {
    // The slide's width/height ratio reserves its space before the picture arrives, so the text under it doesn't jump.
    return (
      <img
        src={src}
        alt={alt}
        className="w-full rounded-lg border border-border bg-card"
        // `auto <ratio>`: the stored ratio holds the space until the picture loads, then its own ratio takes over.
        style={aspect ? { aspectRatio: `auto ${aspect}` } : undefined}
        loading="lazy"
        decoding="async"
      />
    );
  }
  const clamp = (v: number) => Math.min(Math.max(v, 0), 1);
  const x = clamp(crop.x), y = clamp(crop.y);
  const w = Math.max(Math.min(crop.width, 1 - x), 0.05);
  const h = Math.max(Math.min(crop.height, 1 - y), 0.05);
  return (
    <div className="mx-auto max-w-2xl overflow-hidden rounded-lg border border-border bg-black" style={{ aspectRatio: `${w * aspect} / ${h}` }}>
      {/* Percent margins are relative to the container width, so vertical offset is scaled by the slide's aspect. */}
      <img
        src={src}
        alt={alt}
        style={{ width: `${100 / w}%`, maxWidth: "none", marginLeft: `${(-x / w) * 100}%`, marginTop: `${(-y / (w * aspect)) * 100}%` }}
      />
    </div>
  );
}
