import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Check, Circle, X } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { AddMemberDialog } from "@/components/AddMemberDialog";

async function fetchChecklist(dojoId: string) {
  const [members, classes, plans, dojo, memberships] = await Promise.all([
    supabase.from("members").select("id", { count: "exact", head: true }).eq("dojo_id", dojoId),
    supabase.from("classes").select("id", { count: "exact", head: true }).eq("dojo_id", dojoId),
    supabase.from("dojo_plans").select("id", { count: "exact", head: true }).eq("dojo_id", dojoId),
    supabase.from("dojos").select("public_page_enabled").eq("id", dojoId).maybeSingle(),
    supabase.from("dojo_memberships").select("user_id", { count: "exact", head: true }).eq("dojo_id", dojoId),
  ]);
  return {
    hasMember: (members.count ?? 0) > 0,
    hasClass: (classes.count ?? 0) > 0,
    hasPlan: (plans.count ?? 0) > 0,
    publicEnabled: !!dojo.data?.public_page_enabled,
    hasStaff: (memberships.count ?? 0) > 1,
  };
}

interface Props {
  dojoId: string;
  onDismiss: () => void;
}

export function OnboardingChecklist({ dojoId, onDismiss }: Props) {
  const navigate = useNavigate();
  const [addMemberOpen, setAddMemberOpen] = useState(false);
  const { data, isLoading } = useQuery({
    queryKey: ["checklist", dojoId],
    queryFn: () => fetchChecklist(dojoId),
    enabled: !!dojoId,
  });

  if (isLoading || !data) {
    return (
      <div className="rounded-xl bg-card p-5 ring-1 ring-border">
        <div className="h-5 w-40 animate-pulse rounded bg-muted" />
      </div>
    );
  }

  const items = [
    { key: "member", label: "Add your first member", done: data.hasMember, actionLabel: "Add member", onAction: () => setAddMemberOpen(true) },
    { key: "class", label: "Schedule a class", done: data.hasClass, actionLabel: "Schedule class", onAction: () => navigate({ to: "/classes" }) },
    { key: "plan", label: "Create a membership plan", done: data.hasPlan, actionLabel: "Create plan", onAction: () => navigate({ to: "/settings" }) },
    { key: "public", label: "Enable public signup page", done: data.publicEnabled, actionLabel: "Enable signup", onAction: () => navigate({ to: "/settings" }) },
    { key: "staff", label: "Invite a coach or admin", done: data.hasStaff, actionLabel: "Invite staff", onAction: () => navigate({ to: "/settings" }) },
  ];

  const completed = items.filter((i) => i.done).length;
  const total = items.length;
  const allDone = completed === total;

  const dismiss = () => {
    localStorage.setItem(`checklist_dismissed_${dojoId}`, "true");
    onDismiss();
  };

  if (allDone) {
    return (
      <div className="flex items-center justify-between rounded-xl bg-emerald-50 p-5 ring-1 ring-emerald-200 dark:bg-emerald-950/30 dark:ring-emerald-900">
        <div className="flex items-center gap-3">
          <div className="grid size-8 place-items-center rounded-full bg-emerald-500 text-white">
            <Check className="size-5" />
          </div>
          <div>
            <div className="font-display text-lg font-medium text-emerald-900 dark:text-emerald-100">You're all set!</div>
            <div className="text-sm text-emerald-700 dark:text-emerald-300">Your dojo is fully configured.</div>
          </div>
        </div>
        <Button variant="ghost" size="sm" onClick={dismiss}>Dismiss</Button>
      </div>
    );
  }

  return (
    <>
      <div className="rounded-xl bg-card p-5 ring-1 ring-border">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="font-display text-lg font-medium text-card-foreground">Set up your dojo</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">{completed} of {total} complete</p>
          </div>
          <button onClick={dismiss} className="text-muted-foreground hover:text-foreground" aria-label="Dismiss">
            <X className="size-4" />
          </button>
        </div>
        <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div className="h-full bg-brand transition-all" style={{ width: `${(completed / total) * 100}%` }} />
        </div>
        <ul className="mt-4 space-y-2">
          {items.map((item) => (
            <li key={item.key} className="flex items-center justify-between gap-3 rounded-lg px-2 py-1.5">
              <div className="flex items-center gap-3">
                {item.done ? (
                  <div className="grid size-5 place-items-center rounded-full bg-emerald-500 text-white">
                    <Check className="size-3" />
                  </div>
                ) : (
                  <Circle className="size-5 text-muted-foreground/40" />
                )}
                <span className={item.done ? "text-sm text-muted-foreground line-through" : "text-sm text-card-foreground"}>
                  {item.label}
                </span>
              </div>
              {!item.done && (
                <button onClick={item.onAction} className="text-xs font-medium text-brand hover:underline">
                  {item.actionLabel}
                </button>
              )}
            </li>
          ))}
        </ul>
      </div>
      <AddMemberDialog open={addMemberOpen} onOpenChange={setAddMemberOpen} />
    </>
  );
}
