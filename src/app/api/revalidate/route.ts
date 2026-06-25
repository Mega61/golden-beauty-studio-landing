import { NextResponse, type NextRequest } from "next/server";
import { revalidatePath } from "next/cache";

// On-demand ISR. Strapi calls this whenever the owner saves marketing content
// (see the CRM's src/cms/revalidate.ts), so changes appear on the live site in
// ~2s instead of waiting out the 60s revalidate window. Guarded by a shared
// secret. Accepts the secret via the `x-revalidate-secret` header or a `secret`
// query param (so it's also pasteable into a browser for a manual refresh).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isAuthorized(req: NextRequest): boolean {
  const expected = process.env.REVALIDATE_SECRET;
  if (!expected) return false;
  const provided =
    req.headers.get("x-revalidate-secret") ??
    req.nextUrl.searchParams.get("secret");
  return provided === expected;
}

function revalidateAll() {
  // Revalidate every locale of the landing and the /bio route. Passing the
  // dynamic route literal with type "page" refreshes all [lang] variants.
  revalidatePath("/[lang]", "page");
  revalidatePath("/[lang]/bio", "page");
}

export async function POST(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  revalidateAll();
  return NextResponse.json({ ok: true, revalidated: true, now: Date.now() });
}

// Convenience: lets you trigger a manual refresh from the browser address bar
// with ?secret=… — handy for testing without a POST tool.
export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  revalidateAll();
  return NextResponse.json({ ok: true, revalidated: true, now: Date.now() });
}
