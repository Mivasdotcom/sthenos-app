import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import QRCode from "qrcode";
import { supabase } from "@/integrations/supabase/client";
import { PUBLIC_SITE_URL } from "@/lib/site";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import { Check, Copy, Download, QrCode, TriangleAlert } from "lucide-react";

type Row = { slug: string; public_page_enabled: boolean };

export function MemberSignupLinkCard({
  dojoId,
  canEdit,
}: {
  dojoId: string | null;
  canEdit: boolean;
}) {
  const qc = useQueryClient();
  const [copied, setCopied] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["signup-link", dojoId],
    enabled: !!dojoId && canEdit,
    queryFn: async (): Promise<Row | null> => {
      const { data, error } = await supabase
        .from("dojos")
        .select("slug, public_page_enabled")
        .eq("id", dojoId!)
        .maybeSingle();
      if (error) throw error;
      return (data ?? null) as Row | null;
    },
  });

  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    if (data) setEnabled(!!data.public_page_enabled);
  }, [data]);

  const slug = data?.slug ?? "";
  const signupUrl = slug ? `${PUBLIC_SITE_URL}/j/${slug}/signup` : "";

  useEffect(() => {
    if (!signupUrl) {
      setQrDataUrl(null);
      return;
    }
    let cancelled = false;
    QRCode.toDataURL(signupUrl, {
      width: 640,
      margin: 2,
      color: { dark: "#0b1220", light: "#ffffff" },
    })
      .then((url) => {
        if (!cancelled) setQrDataUrl(url);
      })
      .catch(() => setQrDataUrl(null));
    return () => {
      cancelled = true;
    };
  }, [signupUrl]);

  const toggle = useMutation({
    mutationFn: async (next: boolean) => {
      if (!dojoId) throw new Error("No active dojo");
      const { error } = await supabase
        .from("dojos")
        .update({ public_page_enabled: next } as never)
        .eq("id", dojoId);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Updated");
      qc.invalidateQueries({ queryKey: ["signup-link", dojoId] });
      qc.invalidateQueries({ queryKey: ["dojo-settings", dojoId] });
    },
    onError: (e: Error) => {
      setEnabled((v) => !v);
      toast.error(e.message);
    },
  });

  if (!canEdit) return null;

  const shareDisabled = !enabled || !signupUrl || isLoading;

  const copy = async () => {
    if (shareDisabled) return;
    await navigator.clipboard.writeText(signupUrl);
    setCopied(true);
    toast.success("Link copied");
    setTimeout(() => setCopied(false), 2000);
  };

  const download = () => {
    if (shareDisabled || !qrDataUrl) return;
    const a = document.createElement("a");
    a.href = qrDataUrl;
    a.download = `${slug || "signup"}-qr.png`;
    a.click();
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <QrCode className="size-4 text-primary" /> Member signup link
        </CardTitle>
        <CardDescription>
          Share this link or QR code so new members can sign up, pick a plan, and sign your waiver.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between rounded-lg border p-3">
          <div>
            <div className="text-sm font-medium">Public signup page enabled</div>
            <div className="text-xs text-muted-foreground">
              Turn off to stop new signups through this link.
            </div>
          </div>
          <Switch
            checked={enabled}
            disabled={isLoading}
            onCheckedChange={(v) => {
              setEnabled(v);
              toggle.mutate(v);
            }}
          />
        </div>

        {!enabled && !isLoading && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-300/60 bg-amber-100 px-3 py-2 text-sm text-amber-900">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" />
            <span>
              Your public signup page is off — this link and QR code won’t work until you enable it.
            </span>
          </div>
        )}

        <div className="space-y-2">
          <Label>Signup URL</Label>
          <div className="flex gap-2">
            <Input
              readOnly
              value={signupUrl}
              disabled={shareDisabled}
              className="bg-muted/40 font-mono text-xs"
            />
            <Button
              type="button"
              variant="outline"
              onClick={copy}
              disabled={shareDisabled}
              className="shrink-0"
            >
              {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
              <span className="ml-2">{copied ? "Copied!" : "Copy"}</span>
            </Button>
          </div>
        </div>

        <div className="flex flex-col items-center gap-3 rounded-lg border bg-card p-4 sm:flex-row sm:items-center">
          <div
            className={`grid size-40 place-items-center rounded-lg bg-white p-2 ring-1 ring-black/5 ${
              shareDisabled ? "opacity-40 grayscale" : ""
            }`}
          >
            {qrDataUrl ? (
              <img src={qrDataUrl} alt="QR code for member signup link" className="size-full" />
            ) : (
              <span className="text-xs text-muted-foreground">No QR</span>
            )}
          </div>
          <div className="flex-1 space-y-2 text-center sm:text-left">
            <div className="text-sm font-semibold">Front-desk QR code</div>
            <p className="text-xs text-muted-foreground">
              Print it or show it on a tablet so walk-ins can sign up on their own phone.
            </p>
            <Button type="button" variant="secondary" onClick={download} disabled={shareDisabled || !qrDataUrl}>
              <Download className="mr-2 size-4" /> Download PNG
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
