import { auth, defineMcp } from "@lovable.dev/mcp-js";
import listMyDojos from "./tools/list-my-dojos";
import listMembers from "./tools/list-members";
import listClasses from "./tools/list-classes";
import recentAttendance from "./tools/recent-attendance";

// The OAuth issuer MUST be the direct Supabase host. On publish, SUPABASE_URL
// is rewritten to a proxy that mcp-js rejects (RFC 8414 issuer mismatch). The
// project ref survives publish unchanged. Vite inlines VITE_SUPABASE_PROJECT_ID
// as a literal at build time. Fallback keeps the issuer well-formed during the
// throwaway manifest-extract eval; a real token never matches it.
const projectRef = import.meta.env.VITE_SUPABASE_PROJECT_ID ?? "project-ref-unset";

export default defineMcp({
  name: "sthenos-mcp",
  title: "Sthenos Dojo",
  version: "0.1.0",
  instructions:
    "Tools for the Sthenos martial-arts gym app. Start with `list_my_dojos` to get a dojo_id, then use it with `list_members`, `list_classes`, or `recent_attendance`. All results are scoped to the signed-in user's access.",
  auth: auth.oauth.issuer({
    issuer: `https://${projectRef}.supabase.co/auth/v1`,
    acceptedAudiences: "authenticated",
  }),
  tools: [listMyDojos, listMembers, listClasses, recentAttendance],
});
