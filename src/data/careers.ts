import "server-only";
import type { Locale } from "@/app/[lang]/dictionaries";
import type { JobRole } from "./careers.types";

/**
 * The cargos someone can apply for, read from Strapi's `Cargo (vacante)`
 * content type so the owner opens and closes positions herself — no deploy, no
 * hard-coded list.
 *
 * Same contract as `getHeroImage` / the pricing data: when `STRAPI_URL` is unset
 * or the CMS is unreachable, we fall back to a bundled default list so the form
 * still works. An empty cargo list would leave applicants staring at a form they
 * cannot submit, which is the one outcome worth defending against.
 */

export type { JobRole } from "./careers.types";

type StrapiJobRole = {
  slug?: string;
  label_es?: string;
  label_en?: string;
  order?: number;
};

/**
 * Used when the CMS is absent. Slugs match the seed in the CRM
 * (src/cms/careers.ts) so a submission made against the fallback still resolves
 * to a real Cargo once the CMS is reachable again.
 */
const FALLBACK_ROLES: Record<Locale, JobRole[]> = {
  es: [
    { slug: "manicurista", label: "Manicurista" },
    { slug: "auxiliar", label: "Auxiliar de uñas" },
    { slug: "recepcion", label: "Recepción y agenda" },
    { slug: "practicante", label: "Practicante o aprendiz" },
    { slug: "otro", label: "Otro" },
  ],
  en: [
    { slug: "manicurista", label: "Nail technician" },
    { slug: "auxiliar", label: "Nail assistant" },
    { slug: "recepcion", label: "Front desk & scheduling" },
    { slug: "practicante", label: "Intern or apprentice" },
    { slug: "otro", label: "Other" },
  ],
};

export async function getJobRoles(lang: Locale): Promise<JobRole[]> {
  const base = process.env.STRAPI_URL?.trim().replace(/\/+$/, "");
  if (!base) return FALLBACK_ROLES[lang];

  try {
    const url =
      `${base}/api/job-roles?filters[active][$eq]=true&sort=order:asc` +
      `&fields[0]=slug&fields[1]=label_es&fields[2]=label_en&pagination[pageSize]=50`;
    const res = await fetch(url, { next: { revalidate: 60 } });
    if (!res.ok) return FALLBACK_ROLES[lang];

    const json = (await res.json()) as { data?: StrapiJobRole[] };
    const roles = (json.data ?? [])
      .map((r) => ({
        slug: String(r.slug ?? "").trim(),
        // A missing English label falls back to the Spanish one rather than
        // rendering a blank chip.
        label: String(
          (lang === "en" ? r.label_en || r.label_es : r.label_es) ?? "",
        ).trim(),
      }))
      .filter((r) => r.slug !== "" && r.label !== "");

    return roles.length > 0 ? roles : FALLBACK_ROLES[lang];
  } catch {
    return FALLBACK_ROLES[lang];
  }
}
