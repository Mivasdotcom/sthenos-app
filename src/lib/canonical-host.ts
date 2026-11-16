// One canonical origin: when CANONICAL_HOST is set, www.<CANONICAL_HOST> redirects
// to <CANONICAL_HOST>. Unset means no redirect. Alias-free so it loads under plain
// Node (scripts/tests).
export function canonicalHostRedirect(
  request: Request,
  canonicalHost: string | undefined = process.env.CANONICAL_HOST,
): Response | null {
  if (!canonicalHost) return null;
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return null;
  }
  if (url.hostname !== `www.${canonicalHost}`) return null;
  // Internal /api/public/hooks/* endpoints authenticate themselves and must never be redirected.
  if (url.pathname.startsWith("/api/public/hooks/")) return null;
  url.hostname = canonicalHost;
  return Response.redirect(url.toString(), 301);
}
