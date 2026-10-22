import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Link } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { repairEmailDrift } from "@/lib/member-email.functions";

type DriftRow = {
  member_id: string;
  member_name: string;
  member_email: string;
  login_email: string;
};

/**
 * Drift report: members whose contact email no longer matches the address they
 * log in with. Password resets and other account emails go to the login
 * address, so anyone listed here can't reset their password.
 */
export function EmailDriftCard({ dojoId }: { dojoId: string | null }) {
  const qc = useQueryClient();
  const repair = useServerFn(repairEmailDrift);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const { data: rows, isLoading } = useQuery({
    queryKey: ["email-drift", dojoId],
    enabled: !!dojoId,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("member_email_drift", { _dojo_id: dojoId! });
      if (error) throw error;
      return (data ?? []) as DriftRow[];
    },
  });

  const fix = useMutation({
    mutationFn: async (args: { memberIds: string[]; direction: "member" | "login" }) =>
      repair({ data: { dojoId: dojoId!, ...args } }),
    onSuccess: (res) => {
      if (res.failures.length) {
        toast.warning(`${res.fixed} fixed, ${res.failures.length} failed`);
      } else {
        toast.success(`${res.fixed} member${res.fixed === 1 ? "" : "s"} brought back in sync`);
      }
      setSelected(new Set());
      qc.invalidateQueries({ queryKey: ["email-drift"] });
      qc.invalidateQueries({ queryKey: ["members"] });
    },
    onError: (e: any) => toast.error(e?.message ?? "Could not repair"),
  });

  const list = rows ?? [];
  const ids = selected.size ? [...selected] : list.map((r) => r.member_id);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Login email mismatches</CardTitle>
        <CardDescription>
          These members' contact email differs from the address they log in with, so
          password resets and other account emails go to the old address. Choose which
          address is correct and we'll set the member record, login and payment receipts
          to match.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <Skeleton className="h-20 w-full" />
        ) : list.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No mismatches — every member's contact email matches their login.
          </p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-muted-foreground">
                    <th className="w-8 py-1" />
                    <th className="py-1">Member</th>
                    <th className="py-1">Member email</th>
                    <th className="py-1">Login email</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((r) => (
                    <tr key={r.member_id} className="border-t border-border/60">
                      <td className="py-2">
                        <input
                          type="checkbox"
                          aria-label={`Select ${r.member_name}`}
                          checked={selected.has(r.member_id)}
                          onChange={() => toggle(r.member_id)}
                        />
                      </td>
                      <td className="py-2 font-medium">
                        <Link
                          to="/members/$memberId"
                          params={{ memberId: r.member_id }}
                          className="hover:underline"
                        >
                          {r.member_name}
                        </Link>
                      </td>
                      <td className="py-2 text-muted-foreground">{r.member_email}</td>
                      <td className="py-2 text-amber-700">{r.login_email}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                disabled={fix.isPending}
                onClick={() => fix.mutate({ memberIds: ids, direction: "member" })}
              >
                Use member email ({ids.length})
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={fix.isPending}
                onClick={() => fix.mutate({ memberIds: ids, direction: "login" })}
              >
                Use login email ({ids.length})
              </Button>
              <span className="text-xs text-muted-foreground">
                {selected.size ? "Applies to selected members." : "Applies to all listed members."}
              </span>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
