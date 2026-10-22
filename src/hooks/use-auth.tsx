import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { linkMemberOnAuth } from "@/lib/link-member.functions";

type Role = "owner" | "admin" | "coach" | "member" | "pending";

const VIEW_AS_KEY = "sthenos.viewAs";
type ViewAs = "staff" | "member";

interface AuthState {
  session: Session | null;
  user: User | null;
  roles: Role[];
  loading: boolean;
  isStaff: boolean;
  isRealStaff: boolean;
  isManager: boolean;
  isDojoManager: boolean;
  viewAs: ViewAs;

  setViewAs: (v: ViewAs) => void;
  refreshRoles: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [roles, setRoles] = useState<Role[]>([]);
  const [dojoRoles, setDojoRoles] = useState<Role[]>([]);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [rolesLoading, setRolesLoading] = useState(true);

  const loadRoles = async (userId: string) => {
    const [{ data: ur }, { data: dm }] = await Promise.all([
      supabase.from("user_roles").select("role").eq("user_id", userId),
      supabase.from("dojo_memberships").select("role").eq("user_id", userId),
    ]);
    setRoles((ur ?? []).map((r) => r.role as Role));
    setDojoRoles((dm ?? []).map((r) => r.role as Role));
  };

  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, s) => {
      setSession(s);
      if (s?.user) {
        setRolesLoading(true);
        (async () => {
          await loadRoles(s.user.id);
          setRolesLoading(false);
        })();
        if (event === "SIGNED_IN") {
          linkMemberOnAuth()
            .then((res) => {
              if (res?.linked) void loadRoles(s.user.id);
            })
            .catch((err) => {
              console.error("linkMemberOnAuth failed:", err);
            });
        }
      } else {
        setRoles([]);
        setDojoRoles([]);
        setRolesLoading(false);
      }
    });

    supabase.auth.getSession().then(async ({ data: { session: s } }) => {
      setSession(s);
      if (s?.user) {
        // Claim any unlinked member rows for this email, then load roles so the
        // portal resolves without any admin action.
        try {
          await linkMemberOnAuth();
        } catch (err) {
          console.error("linkMemberOnAuth failed:", err);
        }
        await loadRoles(s.user.id);
      } else {
        setRoles([]);
        setDojoRoles([]);
      }
      setRolesLoading(false);
      setSessionLoading(false);
    });

    return () => subscription.unsubscribe();
  }, []);

  const [viewAs, setViewAsState] = useState<ViewAs>("staff");

  useEffect(() => {
    const stored = typeof window !== "undefined" ? window.localStorage.getItem(VIEW_AS_KEY) : null;
    if (stored === "member" || stored === "staff") setViewAsState(stored);
  }, []);

  const setViewAs = (v: ViewAs) => {
    const prev = viewAs;
    setViewAsState(v);
    if (typeof window !== "undefined") window.localStorage.setItem(VIEW_AS_KEY, v);
    if (prev !== v && session?.user) {
      supabase
        .from("view_switch_audit_log")
        .insert({
          user_id: session.user.id,
          user_email: session.user.email ?? "unknown",
          from_view: prev,
          to_view: v,
        })
        .then(({ error }) => {
          if (error) console.error("Failed to log view switch:", error);
        });
    }
  };

  const loading = sessionLoading || rolesLoading;

  const combined = [...roles, ...dojoRoles];
  const isDojoManager = dojoRoles.includes("owner") || dojoRoles.includes("admin");
  const isManager = combined.includes("owner") || combined.includes("admin");
  const realIsStaff = isManager || combined.includes("coach");
  const isStaff = realIsStaff && !(isManager && viewAs === "member");

  const value: AuthState = {
    session,
    user: session?.user ?? null,
    roles,
    loading,
    isStaff,
    isRealStaff: realIsStaff,
    isManager,
    isDojoManager,

    viewAs,
    setViewAs,
    refreshRoles: async () => {
      if (session?.user) await loadRoles(session.user.id);
    },
    signOut: async () => {
      if (typeof window !== "undefined") window.localStorage.removeItem(VIEW_AS_KEY);
      setViewAsState("staff");
      await supabase.auth.signOut();
    },
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
