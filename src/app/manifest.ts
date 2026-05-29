import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Golden Beauty Studio",
    short_name: "Golden",
    description:
      "Estudio especializado en uñas esculpidas en Sabaneta, Antioquia.",
    lang: "es",
    dir: "ltr",
    start_url: "/",
    display: "standalone",
    background_color: "#f8f4ee",
    theme_color: "#f8f4ee",
    categories: ["beauty", "lifestyle"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      {
        src: "/icons/icon-512-maskable.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
