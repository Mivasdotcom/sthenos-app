import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";

const ACTIVE_DOJO_KEY = "sthenos.activeDojoId";

export type DojoRole = "owner" | "admin" | "coach" | "member" | "pending";

export interface DojoMembership {
  dojoId: string;
  name: string;
  slug: string;
  role: DojoRole;
  defaultCurrency: string | null;
  logoPath: string | null;
  stripeChargesEnabled: boolean;
}


/** Roles that grant access to the admin/manager shell. 'member' never does. */
export const STAFF_DOJO_ROLES: DojoRole[] = ["owner", "admin", "coach"];
export function isStaffRole(role: DojoRole | null | undefined): boolean {
  return !!role && STAFF_DOJO_ROLES.includes(role);
}

interface DojoContextValue {
  loading: boolean;
  memberships: DojoMembership[];
  /** Memberships that grant staff access (owner/admin/coach). */
  staffMemberships: DojoMembership[];
  /** True when the user belongs to gyms but only ever as a plain member. */
  isMemberOnly: boolean;
  activeDojoId: string | null;
  activeDojo: DojoMembership | null;
  setActiveDojoId: (id: string) => void;
  needsOnboarding: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}


const DojoContext = createContext<DojoContextValue | null>(null);

export function DojoProvider({ children }: { children: ReactNode }) {
  const { user, loading: authLoading } = useAuth();
  const [memberships, setMemberships] = useState<DojoMembership[]>([]);
  const [hasMemberRecord, setHasMemberRecord] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeDojoId, setActiveDojoIdState] = useState<string | null>(null);

  const fetchMemberships = async () => {
    if (!user) {
      setMemberships([]);
      setHasMemberRecord(false);
      setActiveDojoIdState(null);
      setError(null);
      setLoading(false);
      return;
    }
    const [{ data, error }, { data: memberRows }] = await Promise.all([
      supabase
        .from("dojo_memberships")
        .select(
          "dojo_id, role, dojos:dojo_id (id, name, slug, default_currency, logo_path, archived_at, stripe_charges_enabled)",
        )
        .eq("user_id", user.id),
      // A joined member ALWAYS has a members row, even if the membership row
      // is momentarily missing (fresh public signup). Never show gym-owner
      // onboarding to someone who already belongs to a gym.
      supabase.from("members").select("id").eq("user_id", user.id).limit(1),
    ]);

    setHasMemberRecord((memberRows ?? []).length > 0);

    if (error) {
      console.error("Failed to load dojo memberships:", error);
      // Do NOT fall through to "you have no gyms" — that shows an existing owner
      // an onboarding wizard. Surface an honest error state instead.
      setError(error.message || "We couldn't load your gyms.");
      setLoading(false);
      return;
    }
    setError(null);

    const list: DojoMembership[] = (data ?? [])
      // Archived gyms are hidden everywhere (switcher, lists, auto-selection).
      // They stay in the database and can be restored from Settings.
      .filter((row: any) => !row.dojos?.archived_at)
      .map((row: any) => ({
        dojoId: row.dojo_id,
        name: row.dojos?.name ?? "Dojo",
        slug: row.dojos?.slug ?? "",
        role: row.role as DojoRole,
        defaultCurrency: (row.dojos?.default_currency ?? null) as string | null,
        logoPath: (row.dojos?.logo_path ?? null) as string | null,
        stripeChargesEnabled: !!row.dojos?.stripe_charges_enabled,
      }));

    setMemberships(list);

    // Auto-select: prefer the stored dojo when still valid; otherwise prefer
    // any non-pending membership; otherwise fall back to the first entry.
    const stored = typeof window !== "undefined" ? window.localStorage.getItem(ACTIVE_DOJO_KEY) : null;
    const storedMatch = list.find((m) => m.dojoId === stored);
    const nonPending = list.filter((m) => m.role !== "pending");
    const pick =
      storedMatch?.dojoId ??
      (nonPending.length === 1 ? nonPending[0].dojoId : nonPending[0]?.dojoId ?? list[0]?.dojoId ?? null);
    setActiveDojoIdState(pick);
    // Persist the auto-selection so single-dojo accounts don't re-pick on every load
    if (pick && pick !== stored && typeof window !== "undefined") {
      window.localStorage.setItem(ACTIVE_DOJO_KEY, pick);
    }
    setLoading(false);
  };

  useEffect(() => {
    if (authLoading) return;
    setLoading(true);
    fetchMemberships();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, authLoading]);

  // Public signup creates the auth user first and the membership row a moment
  // later. Without a retry the very first read is empty and the brand-new
  // member is bounced into gym-owner onboarding. Re-check once, quietly.
  useEffect(() => {
    if (loading || error || !user) return;
    if (memberships.length > 0 || hasMemberRecord) return;
    const t = setTimeout(() => void fetchMemberships(), 1500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, error, user?.id, memberships.length, hasMemberRecord]);

  const setActiveDojoId = (id: string) => {
    setActiveDojoIdState(id);
    if (typeof window !== "undefined") window.localStorage.setItem(ACTIVE_DOJO_KEY, id);
  };

  const activeDojo = useMemo(
    () => memberships.find((m) => m.dojoId === activeDojoId) ?? null,
    [memberships, activeDojoId],
  );

  const staffMemberships = useMemo(
    () => memberships.filter((m) => isStaffRole(m.role)),
    [memberships],
  );

  const value: DojoContextValue = {
    loading,
    memberships,
    staffMemberships,
    isMemberOnly: memberships.length > 0 && staffMemberships.length === 0,
    activeDojoId,
    activeDojo,
    setActiveDojoId,
    // Owner onboarding is ONLY for someone with no gym at all — never for a
    // member who has just joined an existing gym.
    needsOnboarding:
      !loading && !error && !!user && memberships.length === 0 && !hasMemberRecord,
    error,
    refresh: fetchMemberships,

  };

  return <DojoContext.Provider value={value}>{children}</DojoContext.Provider>;
}


export function useCurrentDojo() {
  const ctx = useContext(DojoContext);
  if (!ctx) throw new Error("useCurrentDojo must be used within DojoProvider");
  return ctx;
}
