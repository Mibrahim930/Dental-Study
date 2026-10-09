import type { MetadataRoute } from "next";

/** Lets students add the site to their phone's home screen. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Lolo's Study Buddy",
    short_name: "Study Buddy",
    description: "Learn your own lectures, one slide at a time.",
    start_url: "/",
    display: "standalone",
    background_color: "#efede6",
    theme_color: "#0e5e55",
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml" },
      { src: "/apple-icon", sizes: "180x180", type: "image/png" },
    ],
  };
}
