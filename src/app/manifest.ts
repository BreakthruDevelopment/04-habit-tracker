import type { MetadataRoute } from "next";

// Colours match the tokens in globals.css (--accent and --background, light theme).
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Habit and Goal Tracker",
    short_name: "Habits",
    description: "Daily habits, weekly goals and a gentle reminder.",
    start_url: "/today",
    scope: "/",
    display: "standalone",
    theme_color: "#005fb1",
    background_color: "#f5f6f8",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
