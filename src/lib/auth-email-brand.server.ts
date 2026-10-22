// Branding for AUTH emails (signup, recovery, magic link, invite, email change).
//
// These are sent by the platform, not by a gym, so the product name is the
// baseline. Where the recipient belongs to exactly ONE live gym we use that
// gym's name instead — a member thinks of themselves as belonging to their gym,
// not to the platform. Anything ambiguous (several gyms, no match, a
// placeholder name) falls back to the product name. The project slug must never
// appear.

export const PRODUCT_NAME = "Sthenos";

const PLACEHOLDER_NAMES = ["your dojo", "your gym", "dojo connect", "xalarosi", "sthenos"];

/**
 * Resolve the display name to use for an auth email sent to `email`.
 * Never throws — branding must never block an auth email.
 */
export async function resolveAuthEmailBrand(
  supabase: { from: (t: string) => any },
  email: string | null | undefined,
): Promise<string> {
  const address = email?.trim().toLowerCase();
  if (!address) return PRODUCT_NAME;

  try {
    const { data, error } = await supabase
      .from("members")
      .select("dojo_id, dojos!inner(name, archived_at)")
      .ilike("email", address)
      .limit(20);
    if (error || !data?.length) return PRODUCT_NAME;

    const names = new Set<string>();
    for (const row of data as Array<{ dojos?: { name?: string | null; archived_at?: string | null } }>) {
      const dojo = row.dojos;
      if (!dojo || dojo.archived_at) continue;
      const name = dojo.name?.trim();
      if (!name || PLACEHOLDER_NAMES.includes(name.toLowerCase())) continue;
      names.add(name);
    }
    if (names.size !== 1) return PRODUCT_NAME;
    return [...names][0]!;
  } catch {
    return PRODUCT_NAME;
  }
}

/** Sender display name: the gym, attributed to the platform for recognition. */
export function senderDisplayName(brand: string): string {
  return brand === PRODUCT_NAME ? PRODUCT_NAME : `${brand} · ${PRODUCT_NAME}`;
}
