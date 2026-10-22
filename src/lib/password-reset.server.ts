// Only ever build reset links back to an origin we control. A caller-supplied
// origin is honoured so preview/published deployments each keep their own
// round-trip, but anything unrecognised falls back to the canonical site.
import { PUBLIC_SITE_URL } from "@/lib/site";

const ALLOWED = [
  /^https:\/\/sthenos\.live$/,
  /^https:\/\/www\.sthenos\.live$/,
  /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.lovable\.app$/,
  /^http:\/\/localhost:\d+$/,
];

export function safeOrigin(origin?: string | null): string {
  const value = origin?.trim().replace(/\/+$/, "");
  if (value && ALLOWED.some((re) => re.test(value))) return value;
  return PUBLIC_SITE_URL;
}
