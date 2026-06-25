"use client";

import Image from "next/image";
import { useState } from "react";
import PhotoLightbox, { type PhotoLightboxDict } from "./PhotoLightbox";

type StudioPhoto = { src: string; alt: string };

// Client wrapper around the studio photo grid. Keeps the open-index state and
// opens the shared PhotoLightbox.
//
// The CMS (`studio-photo` collection) can hold any number of photos, so the
// layout is count-adaptive rather than hardcoded to three:
//   • 1–3 photos → the signature big-left / stacked-right editorial block.
//   • 4+ photos  → that same hero block (hero + first two companions) followed
//     by an overflow grid that absorbs the rest, its column count tuned to how
//     many remain so a lone overflow photo reads as a second featured rather
//     than a stranded thumbnail.
export default function EstudioGallery({
  photos,
  dict,
}: {
  photos: StudioPhoto[];
  dict: PhotoLightboxDict;
}) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  if (photos.length === 0) return null;

  const [first, ...rest] = photos;
  const side = rest.slice(0, 2); // up to two companions beside the hero
  const overflow = rest.slice(2); // 4th photo onward flows below

  // Desktop column count for the overflow grid, capped at 3. A single overflow
  // photo spans full width (reads as a second hero); two sit side by side.
  const overflowCols =
    overflow.length >= 3
      ? "md:grid-cols-3"
      : overflow.length === 2
        ? "md:grid-cols-2"
        : "md:grid-cols-1";
  const overflowColsMobile = overflow.length === 1 ? "grid-cols-1" : "grid-cols-2";

  return (
    <>
      <div
        className={`grid gap-2 md:grid-cols-[2fr_1fr] md:gap-3.5 ${
          overflow.length > 0 ? "mb-2 md:mb-3.5" : "mb-10 md:mb-16"
        }`}
      >
        <PhotoTile
          photo={first}
          sizes="(min-width: 768px) 66vw, 100vw"
          onClick={() => setOpenIndex(0)}
        />
        {side.length > 0 ? (
          <div className="grid grid-cols-2 gap-2 md:grid-cols-1 md:gap-3.5">
            {side.map((photo, i) => (
              <PhotoTile
                key={photo.src}
                photo={photo}
                sizes="(min-width: 768px) 33vw, 50vw"
                onClick={() => setOpenIndex(i + 1)}
              />
            ))}
          </div>
        ) : null}
      </div>

      {overflow.length > 0 ? (
        <div
          className={`mb-10 grid gap-2 md:mb-16 md:gap-3.5 ${overflowColsMobile} ${overflowCols}`}
        >
          {overflow.map((photo, i) => (
            <PhotoTile
              key={photo.src}
              photo={photo}
              sizes="(min-width: 768px) 33vw, 50vw"
              onClick={() => setOpenIndex(i + 1 + side.length)}
            />
          ))}
        </div>
      ) : null}

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
