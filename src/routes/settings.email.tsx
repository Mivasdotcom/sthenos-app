import { PUBLIC_SITE_URL } from "@/lib/site";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useCurrentDojo } from "@/hooks/use-current-dojo";
import { PageHeader } from "@/components/PageHeader";
import { EmailSettingsCard } from "@/components/EmailSettingsCard";
import { EmailDriftCard } from "@/components/EmailDriftCard";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ArrowLeft, RefreshCw, Send, ShieldAlert, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { getEmailHealth, retryEmailSend } from "@/lib/email-health.functions";
import { sendTestEmail } from "@/lib/email-settings.functions";

const TITLE = "Email health \u2014 Settings \u2014 Sthenos";
const DESC =
  "See every email your gym has sent, spot failures, retry them, and check your sending domain.";

export const Route = createFileRoute("/settings/email")({
  head: () => ({
    meta: [
      { title: TITLE },
      { name: "description", content: DESC },
      { property: "og:title", content: TITLE },
      { property: "og:description", content: DESC },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { property: "og:url", content: `${PUBLIC_SITE_URL}/settings/email` },
    ],
    links: [{ rel: "canonical", href: `${PUBLIC_SITE_URL}/settings/email` }],
  }),
  component: SettingsEmailPage,
});

const RANGES = [
  { days: 1, label: "24 hours" },
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
] as const;

function statusBadge(status: string) {
  if (status === "sent") return <Badge className="bg-emerald-600 hover:bg-emerald-600">Sent</Badge>;
  if (status === "pending") return <Badge variant="secondary">Pending</Badge>;
  if (status === "suppressed") return <Badge variant="outline">Suppressed</Badge>;
  return <Badge variant="destructive">Failed</Badge>;
}

function SettingsEmailPage() {
  const { activeDojoId, activeDojo } = useCurrentDojo();
  const canEdit = activeDojo?.role === "owner" || activeDojo?.role === "admin";
  const qc = useQueryClient();
  const load = useServerFn(getEmailHealth);
  const retry = useServerFn(retryEmailSend);
  const test = useServerFn(sendTestEmail);
  const [days, setDays] = useState<number>(7);
  const [testTo, setTestTo] = useState("");

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ["email-health", activeDojoId, days],
    queryFn: () => load({ data: { dojoId: activeDojoId!, days } }),
    enabled: !!activeDojoId,
  });

  const retrying = useMutation({
    mutationFn: (logId: string) => retry({ data: { dojoId: activeDojoId!, logId } }),
    onSuccess: (r: any) => {
      if (r.ok) toast.success(`Sent to ${r.to}`);
      else if (r.pending) toast.warning("Still waiting on domain verification");
      else toast.error("Retry failed", { description: r.error ?? undefined });
      qc.invalidateQueries({ queryKey: ["email-health"] });
    },
    onError: (e: any) => toast.error(e?.message ?? "Could not retry that email"),
  });

  const testing = useMutation({
    mutationFn: () => test({ data: { dojoId: activeDojoId!, to: testTo.trim() || undefined } }),
    onSuccess: (r: any) => {
      if (r.ok) toast.success(r.message, { description: r.detail ?? undefined });
      else if (r.pending)
        toast.warning("Email pending domain verification", { description: r.message ?? undefined });
      else toast.error("Test email failed", { description: r.message ?? "Unknown error" });
      qc.invalidateQueries({ queryKey: ["email-health"] });
    },
    onError: (e: any) => toast.error(e?.message ?? "Could not send test email"),
  });

  const stats = data?.stats;

  return (
    <main>
      <PageHeader
        title="Email"
        subtitle="Who you send as, what has actually gone out, and anything that failed"
      />
      <div className="mx-auto max-w-4xl space-y-6 p-6">
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link to="/settings">
            <ArrowLeft className="mr-2 h-4 w-4" /> Back to settings
          </Link>
        </Button>

        {activeDojoId ? <EmailSettingsCard dojoId={activeDojoId} canEdit={!!canEdit} showTest={false} /> : null}

        {data && !data.domain.verified ? (
          <Alert>
            <TriangleAlert className="h-4 w-4" />
            <AlertTitle>Sending domain not verified yet</AlertTitle>
            <AlertDescription>
              {data.domain.reason ??
                `${data.domain.name} is still being verified. Emails are held until it is ready, then they go out.`}
            </AlertDescription>
          </Alert>
        ) : null}

        <EmailDriftCard dojoId={activeDojoId ?? null} />

        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <CardTitle className="text-base">Recent sends</CardTitle>
                <CardDescription>
                  One row per email. Anything not marked Sent did not reach the member.
                </CardDescription>
              </div>
              <div className="flex items-center gap-1">
                {RANGES.map((r) => (
                  <Button
                    key={r.days}
                    size="sm"
                    variant={days === r.days ? "default" : "outline"}
                    onClick={() => setDays(r.days)}
                  >
                    {r.label}
                  </Button>
                ))}
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label="Refresh"
                  onClick={() => qc.invalidateQueries({ queryKey: ["email-health"] })}
                >
                  <RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {isLoading ? (
              <Skeleton className="h-40 w-full" />
            ) : (
              <>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  {[
                    { label: "Emails", value: stats?.total ?? 0 },
                    { label: "Sent", value: stats?.sent ?? 0 },
                    { label: "Failed", value: stats?.failed ?? 0 },
                    { label: "Waiting", value: stats?.pending ?? 0 },
                  ].map((s) => (
                    <div key={s.label} className="rounded-lg border p-3">
                      <div className="text-2xl font-semibold tabular-nums">{s.value}</div>
                      <div className="text-xs text-muted-foreground">{s.label}</div>
                    </div>
                  ))}
                </div>

                {(data?.rows.length ?? 0) === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No emails in this period. Use the test send below to check sending end to end.
                  </p>
                ) : (
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>When</TableHead>
                          <TableHead>Type</TableHead>
                          <TableHead>To</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead className="text-right">Action</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {data!.rows.map((r) => (
                          <TableRow key={r.id}>
                            <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                              {new Date(r.createdAt).toLocaleString()}
                            </TableCell>
                            <TableCell className="text-sm">{r.template}</TableCell>
                            <TableCell className="text-sm">{r.recipient}</TableCell>
                            <TableCell>
                              <div className="space-y-1">
                                {statusBadge(r.status)}
                                {r.error ? (
                                  <div className="max-w-[22rem] text-xs text-muted-foreground">
                                    {r.error}
                                  </div>
                                ) : null}
                              </div>
                            </TableCell>
                            <TableCell className="text-right">
                              {r.retryable && canEdit ? (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled={retrying.isPending}
                                  onClick={() => retrying.mutate(r.id)}
                                >
                                  Retry
                                </Button>
                              ) : null}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>

        {data && data.suppressed.length > 0 ? (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <ShieldAlert className="h-4 w-4" /> Blocked addresses
              </CardTitle>
              <CardDescription>
                These addresses bounced, complained, or unsubscribed, so nothing can be delivered to
                them.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {data.suppressed.map((s) => (
                <div key={s.email} className="flex items-center justify-between text-sm">
                  <span>{s.email}</span>
                  <span className="text-xs text-muted-foreground">{s.reason}</span>
                </div>
              ))}
            </CardContent>
          </Card>
        ) : null}

        {canEdit ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Test send</CardTitle>
              <CardDescription>
                Sends a real email through the same pipeline your members use, and logs the result
                above.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap items-end gap-3">
              <div className="min-w-[16rem] flex-1 space-y-2">
                <Label htmlFor="test-to">Send to</Label>
                <Input
                  id="test-to"
                  type="email"
                  placeholder="your own address (default)"
                  value={testTo}
                  onChange={(e) => setTestTo(e.target.value)}
                />
              </div>
              <Button onClick={() => testing.mutate()} disabled={testing.isPending}>
                <Send className="mr-2 h-4 w-4" />
                {testing.isPending ? "Sending\u2026" : "Send test email"}
              </Button>
            </CardContent>
          </Card>
        ) : null}
      </div>
    </main>
  );
}
