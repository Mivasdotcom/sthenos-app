// Pure, shared copy + labels for family plans. Safe to import anywhere.

/** The one-line explanation of how a family plan actually works. */
export function familyPlanExplainer(maxFamilyMembers?: number | null): string {
  const cap = maxFamilyMembers && maxFamilyMembers > 0 ? maxFamilyMembers : null;
  return `One member pays; up to ${cap ?? "any number of"} family members train on this plan. Everyone gets their own profile, attendance and belt tracking.`;
}

/** How many extra people a payer can add on a family plan. */
export function dependentCap(maxFamilyMembers?: number | null): number | null {
  if (!maxFamilyMembers || maxFamilyMembers <= 1) return null;
  return maxFamilyMembers - 1;
}

/**
 * The at-a-glance family label for a members-list row.
 * Payers read "Family: Silva family · payer"; dependents "Covered by Silva family".
 */
export function familyRowLabel(opts: {
  groupName: string | null | undefined;
  isPayer: boolean;
  coveredByName?: string | null;
}): string | null {
  if (opts.isPayer) {
    return `Family: ${opts.groupName ?? "family plan"} · payer`;
  }
  if (opts.coveredByName) {
    return `Covered by ${opts.coveredByName}'s family plan`;
  }
  if (opts.groupName) return `Family: ${opts.groupName}`;
  return null;
}
