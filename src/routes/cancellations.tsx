import { PUBLIC_SITE_URL } from "@/lib/site";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useCurrentDojo } from "@/hooks/use-current-dojo";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { EndMembershipDialog } from "@/components/EndMembershipDialog";
import { toast } from "sonner";
import { useState } from "react";

export const Route = createFileRoute("/cancellations")({
  head: () => ({
    meta: [
      { title: "Cancellations \u2014 Sthenos" },
      { name: "description", content: "Review and action pending membership cancellation requests." },
      { property: "og:title", content: "Cancellations \u2014 Sthenos" },
      { property: "og:description", content: "Review and action pending membership cancellation requests." },
      { property: "og:url", content: `${PUBLIC_SITE_URL}/cancellations` },
      { name: "twitter:title", content: "Cancellations \u2014 Sthenos" },
      { name: "twitter:description", content: "Review and action pending membership cancellation requests." },
    ],
    links: [{ rel: "canonical", href: `${PUBLIC_SITE_URL}/cancellations` }],
  }),
  component: CancellationsPage,
});

type CancellationRow = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  plan: string | null;
  status: string;
  cancellation_requested_at: string;
  cancellation_reason: string | null;
};

function CancellationsPage() {
  const { isStaff, isManager, viewAs } = useAuth();
  const { activeDojoId } = useCurrentDojo();
  const qc = useQueryClient();

  const canManage = isStaff && isManager && viewAs === "staff";

  const { data: rows, isLoading } = useQuery({
    queryKey: ["cancellations", activeDojoId],
    enabled: !!activeDojoId && canManage,
    queryFn: async (): Promise<CancellationRow[]> => {
      const { data, error } = await supabase
        .from("members")
        .select("id, name, email, phone, plan, status, cancellation_requested_at, cancellation_reason")
        .eq("dojo_id", activeDojoId!)
        .not("cancellation_requested_at", "is", null)
        .order("cancellation_requested_at", { ascending: true });
      if (error) throw error;
      return (data ?? []) as CancellationRow[];
    },
  });

  async function notifyMember(row: CancellationRow, action: "confirmed" | "dismissed") {
    if (!row.email) return;
    try {
      const { data: sess } = await supabase.auth.getSession();
      await fetch("/lovable/email/transactional/send", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(sess.session?.access_token
            ? { Authorization: `Bearer ${sess.session.access_token}` }
            : {}),
        },
        body: JSON.stringify({
          templateName:
            action === "confirmed" ? "cancellation-confirmed" : "cancellation-dismissed",
          recipientEmail: row.email,
          idempotencyKey: `cancel-${action}-${row.id}-${Date.now()}`,
          templateData: { name: row.name },
        }),
      });
    } catch {}
  }

  const [endTarget, setEndTarget] = useState<CancellationRow | null>(null);


  const dismiss = useMutation({
    mutationFn: async (row: CancellationRow) => {
      const { data: { user } } = await supabase.auth.getUser();
      const { error } = await supabase
        .from("members")
        .update({ cancellation_requested_at: null, cancellation_reason: null })
        .eq("id", row.id)
        .eq("dojo_id", activeDojoId!);
      if (error) throw error;
      await supabase.from("cancellation_audit_log").insert({
        member_id: row.id,
        dojo_id: activeDojoId!,
        action: "dismissed",
        reason: row.cancellation_reason,
        actor_user_id: user?.id ?? null,
      });
      await notifyMember(row, "dismissed");
    },
    onSuccess: () => {
      toast.success("Cancellation request dismissed");
      qc.invalidateQueries({ queryKey: ["cancellations"] });
      qc.invalidateQueries({ queryKey: ["members"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (!canManage) {
    return (
      <div className="space-y-4 p-6">
        <h1 className="text-2xl font-semibold">Cancellations</h1>
        <p className="text-sm text-muted-foreground">
          Only managers in staff view can review cancellation requests.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      <header className="space-y-1">
        <h1 className="font-display text-3xl font-semibold tracking-tight">Cancellation requests</h1>
        <p className="text-sm text-muted-foreground">
          Members below have submitted notice. Confirm the cancellation to mark them lapsed, or dismiss
          if you&rsquo;ve resolved it offline.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Pending requests</CardTitle>
          <CardDescription>
            {isLoading ? "Loading\u2026" : `${rows?.length ?? 0} awaiting review`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : (rows?.length ?? 0) === 0 ? (
            <p className="text-sm text-muted-foreground">No outstanding cancellation requests.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Member</TableHead>
                  <TableHead>Plan</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Submitted</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows!.map((row) => (
                  <CancellationRowView
                    key={row.id}
                    row={row}
                    onConfirm={() => setEndTarget(row)}
                    onDismiss={() => dismiss.mutate(row)}
                    busy={dismiss.isPending}
                  />
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <EndMembershipDialog
        open={!!endTarget}
        onOpenChange={(o) => !o && setEndTarget(null)}
        dojoId={activeDojoId ?? null}
        member={endTarget ? { id: endTarget.id, name: endTarget.name } : null}
        reason={endTarget?.cancellation_reason ?? null}
        source="cancellation request"
        onDone={() => {
          if (endTarget) void notifyMember(endTarget, "confirmed");
          setEndTarget(null);
        }}
      />
    </div>
  );
}

function CancellationRowView({
  row,
  onConfirm,
  onDismiss,
  busy,
}: {
  row: CancellationRow;
  onConfirm: () => void;
  onDismiss: () => void;
  busy: boolean;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const submitted = new Date(row.cancellation_requested_at);
  return (
    <TableRow>
      <TableCell>
        <div className="font-medium">
          <Link to="/members/$memberId" params={{ memberId: row.id }} className="hover:underline">
            {row.name}
          </Link>
        </div>
        <div className="text-xs text-muted-foreground">{row.email ?? row.phone ?? "\u2014"}</div>
      </TableCell>
      <TableCell className="text-sm">{row.plan ?? "\u2014"}</TableCell>
      <TableCell>
        <Badge variant={row.status === "active" ? "default" : "secondary"}>{row.status}</Badge>
      </TableCell>
      <TableCell className="text-sm text-muted-foreground">
        {submitted.toLocaleDateString()}
      </TableCell>
      <TableCell className="max-w-xs text-sm text-muted-foreground">
        {row.cancellation_reason || <span className="italic">No reason given</span>}
      </TableCell>
      <TableCell className="text-right">
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" disabled={busy} onClick={onDismiss}>
            Dismiss
          </Button>
          <Button variant="destructive" size="sm" disabled={busy} onClick={onConfirm}>
            Confirm cancellation
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}
