// Pure sender-identity derivation for platform email. Alias-free so that
// scripts/tests can load it under plain Node. email-send.server.ts feeds it the
// raw env values and re-exports the results.
import { envOr } from "./env.ts";

/**
 * Normalise the configured sending domain. When none is configured (unset or
 * empty), derive `notify.<host of siteUrl>`. Tolerates a full address or URL
 * having been configured by mistake.
 */
export function normaliseDomain(raw: string | undefined | null, siteUrl: string): string {
  const value = envOr(raw, `notify.${new URL(siteUrl).hostname}`).toLowerCase();
  const host = value.includes("@") ? value.split("@").pop()! : value.replace(/^https?:\/\//, "");
  return host.replace(/\/.*$/, "").replace(/^\.+|\.+$/g, "");
}

/** Local part of the platform sender. Defaults to `noreply` when unset or empty. */
export function resolveFromLocalPart(raw: string | undefined | null): string {
  return envOr(raw, "noreply").toLowerCase();
}
