/**
 * ONE substitution implementation, shared by the Marketing page preview and the
 * actual broadcast send. When these drifted apart, the preview rendered the raw
 * "Hey {{name}}," while nobody could tell whether the send itself substituted.
 * Keep them on this function so what staff see is what recipients get.
 */

export type PersonalizationTarget = {
  name?: string | null;
  discipline?: string | null;
  /** Belt/rank label, e.g. "Blue Belt". */
  belt?: string | null;
};

/** Supported merge fields, shown in the editor hint. */
export const MERGE_FIELDS = ["name", "discipline", "belt"] as const;

/** Regex-safe token match: tolerates {{name}}, {{ name }}, {{NAME}}. */
function token(field: string): RegExp {
  return new RegExp(`\\{\\{\\s*${field}\\s*\\}\\}`, "gi");
}

/**
 * Fallbacks matter: an empty discipline must not leave "you train " dangling,
 * and a missing name must never render "Hey ,".
 */
export function personalize(template: string, target: PersonalizationTarget): string {
  const firstName = (target.name ?? "").trim().split(/\s+/)[0] || "there";
  return template
    .replace(token("name"), firstName)
    .replace(token("discipline"), (target.discipline ?? "").trim() || "training")
    .replace(token("belt"), (target.belt ?? "").trim() || "your current rank");
}

/** True when the text still contains an unsubstituted merge field. */
export function hasUnresolvedMergeFields(text: string): boolean {
  return /\{\{\s*[a-z_]+\s*\}\}/i.test(text);
}
