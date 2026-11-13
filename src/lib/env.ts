// Alias-free on purpose: loaded by plain Node in scripts/tests.
//
// Docker `ARG X` + `ENV X=$X`, compose `${X:-}` and `.env.example` `KEY=""` all
// produce empty strings. `??` does not catch "", so every default goes through
// these helpers, which treat undefined, null, "" and whitespace-only as unset.

/** The trimmed value, or undefined when it is missing or blank. */
export function envOptional(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** The trimmed value, or `fallback` when it is missing or blank. */
export function envOr(value: string | undefined | null, fallback: string): string {
  return envOptional(value) ?? fallback;
}
