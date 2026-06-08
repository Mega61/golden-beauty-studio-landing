"use client";

import Image from "next/image";
import { useState } from "react";
import PhotoLightbox, { type PhotoLightboxDict } from "./PhotoLightbox";

type StudioPhoto = { src: string; alt: string };

// Client wrapper around the studio photo grid: keeps the open-index state and
// opens the shared PhotoLightbox. The big-left / two-stacked-right layout
// mirrors the original static markup from Estudio.
export default function EstudioGallery({
  photos,
  dict,
}: {
  photos: StudioPhoto[];
  dict: PhotoLightboxDict;
}) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  const [first, ...rest] = photos;

  return (
    <>
      <div className="mb-10 grid gap-2 md:mb-16 md:grid-cols-[2fr_1fr] md:gap-3.5">
        {first ? (
          <PhotoTile
            photo={first}
            sizes="(min-width: 768px) 66vw, 100vw"
            onClick={() => setOpenIndex(0)}
          />
        ) : null}
        <div className="grid grid-cols-2 gap-2 md:grid-cols-1 md:gap-3.5">
          {rest.map((photo, i) => (
            <PhotoTile
              key={photo.src}
              photo={photo}
              sizes="(min-width: 768px) 33vw, 50vw"
              onClick={() => setOpenIndex(i + 1)}
            />
          ))}
        </div>
      </div>

      {openIndex !== null && (
        <PhotoLightbox
          photos={photos.map((p) => ({ src: p.src, alt: p.alt, caption: p.alt }))}
          startIndex={openIndex}
          dict={dict}
          onClose={() => setOpenIndex(null)}
        />
      )}
    </>
  );
}

function PhotoTile({
  photo,
  sizes,
  onClick,
}: {
  photo: StudioPhoto;
  sizes: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={photo.alt}
      className="relative block w-full cursor-zoom-in overflow-hidden bg-cream p-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold"
      style={{ aspectRatio: "5 / 3" }}
    >
      <Image src={photo.src} alt={photo.alt} fill sizes={sizes} className="object-cover" />
    </button>
  );
}
