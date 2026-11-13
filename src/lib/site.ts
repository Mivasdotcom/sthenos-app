// Two distinct concepts:
//
// SITE_URL — the origin the user is currently browsing. Correct for internal
// navigation and for round-trip redirects (Stripe success/cancel, billing
// portal return, Connect onboarding), where you should come back to where you
// started. Falls back to the canonical origin during SSR.
//
// PUBLIC_SITE_URL — the canonical production origin, always. Use it for any
// link that gets SHARED with someone else or embedded in content: gym signup
// links + QR codes, payment/invite links, links inside emails, sitemap,
// robots.txt and og:url / canonical meta tags.

import { envOptional, envOr } from "./env.ts";

const CANONICAL_ORIGIN = "https://sthenos.live";

/**
 * Canonical production origin. Override with VITE_PUBLIC_SITE_URL for local dev.
 * An empty value (build arg or .env placeholder) counts as unset at both steps:
 * Vite inlines the build-time value as "" when it was passed empty.
 */
export const PUBLIC_SITE_URL =
  envOptional(
    typeof import.meta !== "undefined"
      ? (import.meta as unknown as { env?: Record<string, string | undefined> }).env
          ?.VITE_PUBLIC_SITE_URL
      : undefined,
  ) ??
  envOptional(typeof process !== "undefined" ? process.env?.VITE_PUBLIC_SITE_URL : undefined) ??
  CANONICAL_ORIGIN;

/** The origin currently being browsed (canonical during SSR). */
export const SITE_URL =
  typeof window !== "undefined"
    ? window.location.origin
    : envOr(process.env.VITE_SITE_URL, CANONICAL_ORIGIN);
