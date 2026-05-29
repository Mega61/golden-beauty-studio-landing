import { buildJsonLd } from "@/lib/schema";
import type { Dictionary, Locale } from "../dictionaries";

// Server-rendered JSON-LD structured data. The Metadata API has no field for
// JSON-LD, so it's injected as a script tag (Google's recommended approach).
export default function JsonLd({
  lang,
  dict,
}: {
  lang: Locale;
  dict: Dictionary;
}) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(buildJsonLd(lang, dict)) }}
    />
  );
}
