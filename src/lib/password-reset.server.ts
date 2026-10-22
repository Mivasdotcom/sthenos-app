// Only ever build reset links back to an origin we control. A caller-supplied
// origin is honoured only when it matches the configured site (PUBLIC_SITE_URL,
// including its www. variant) or is a localhost dev origin. Anything else falls
// back to PUBLIC_SITE_URL. Imports stay alias-free so this module also loads
// under plain Node (scripts/tests).
import { PUBLIC_SITE_URL } from "./site.ts";

const LOCALHOST_ORIGIN = /^http:\/\/localhost:\d+$/;

function configuredOrigins(siteUrl: string): Set<string> {
  const site = new URL(siteUrl);
  const origins = new Set([site.origin]);
  if (!site.hostname.startsWith("www.")) {
    const www = new URL(site.origin);
    www.hostname = `www.${site.hostname}`;
    origins.add(www.origin);
  }
  return origins;
}

const ALLOWED_ORIGINS = configuredOrigins(PUBLIC_SITE_URL);

export function safeOrigin(origin?: string | null): string {
  const value = origin?.trim().replace(/\/+$/, "");
  if (value && (ALLOWED_ORIGINS.has(value) || LOCALHOST_ORIGIN.test(value))) return value;
  return PUBLIC_SITE_URL;
}
