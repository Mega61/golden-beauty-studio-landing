// Reuse the Open Graph image for the Twitter/X card. A generated
// opengraph-image does not auto-populate twitter:image, so we re-export it
// here to emit an explicit twitter:image tag.
export {
  default,
  alt,
  size,
  contentType,
  generateStaticParams,
} from "./opengraph-image";
