import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Mail, Send } from "lucide-react";
import { getEmailSettings, saveEmailSettings, sendTestEmail } from "@/lib/email-settings.functions";

export function EmailSettingsCard({
  dojoId,
  canEdit,
  showTest = true,
}: {
  dojoId: string;
  canEdit: boolean;
  /** Hidden on Settings → Email, which has a richer test send of its own. */
  showTest?: boolean;
}) {
  const qc = useQueryClient();
  const load = useServerFn(getEmailSettings);
  const save = useServerFn(saveEmailSettings);
  const test = useServerFn(sendTestEmail);

  const { data, isLoading } = useQuery({
    queryKey: ["email-settings", dojoId],
    queryFn: () => load({ data: { dojoId } }),
    enabled: !!dojoId,
  });

  const [fromName, setFromName] = useState("");
  const [replyTo, setReplyTo] = useState("");

  useEffect(() => {
    if (data?.settings) {
      setFromName(data.settings.from_name ?? "");
      setReplyTo(data.settings.from_address ?? "");
    }
  }, [data]);

  const saving = useMutation({
    mutationFn: () => save({ data: { dojoId, from_name: fromName, from_address: replyTo } }),
    onSuccess: () => {
      toast.success("Email settings saved");
      qc.invalidateQueries({ queryKey: ["email-settings", dojoId] });
    },
    onError: (e: any) => toast.error(e?.message ?? "Could not save email settings"),
  });

  const testing = useMutation({
    mutationFn: () => test({ data: { dojoId } }),
    onSuccess: (r: any) => {
      if (r.ok) toast.success(r.message, { description: r.detail ?? undefined });
      else if (r.pending)
        toast.warning("Email pending domain verification", { description: r.message ?? undefined });
      else toast.error("Test email failed", { description: r.message ?? "Unknown provider error" });
    },
    onError: (e: any) => toast.error(e?.message ?? "Could not send test email"),
  });

  const sending = data?.sending;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Mail className="h-4 w-4" /> Email
            </CardTitle>
            <CardDescription>
              Members see your gym's name in their inbox, and replies come straight to you.
            </CardDescription>
          </div>
          {sending ? (
            <Badge variant={sending.verified ? "default" : "secondary"}>
              {sending.verified ? `Sending from ${sending.domain}` : "Pending domain verification"}
            </Badge>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="email-from-name">Sender name</Label>
            <Input
              id="email-from-name"
              value={fromName}
              disabled={!canEdit || isLoading}
              placeholder={data?.defaults.from_name ?? "Your gym"}
              onChange={(e) => setFromName(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="email-reply-to">Reply-to email</Label>
            <Input
              id="email-reply-to"
              type="email"
              value={replyTo}
              disabled={!canEdit || isLoading}
              placeholder={data?.defaults.from_address ?? "you@yourgym.com"}
              onChange={(e) => setReplyTo(e.target.value)}
            />
          </div>
        </div>

        <p className="text-xs text-muted-foreground">
          Emails are sent from <span className="font-mono">{sending?.fromAddress ?? "…"}</span>
          {sending && !sending.verified && sending.reason ? ` — ${sending.reason}` : ""}
        </p>

        {canEdit ? (
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => saving.mutate()} disabled={saving.isPending || isLoading}>
              {saving.isPending ? "Saving…" : "Save"}
            </Button>
            {showTest ? (
              <Button variant="outline" onClick={() => testing.mutate()} disabled={testing.isPending}>
                <Send className="mr-2 h-4 w-4" />
                {testing.isPending ? "Sending…" : "Send test email"}
              </Button>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
