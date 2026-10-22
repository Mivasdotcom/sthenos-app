import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { FileText, ExternalLink, Loader2, Check, RefreshCw, AlertTriangle } from "lucide-react";
import {
  PRIVACY_NOTICE_OPERATOR_NOTE,
  PRIVACY_NOTICE_TITLE,
  buildPrivacyNotice,
} from "@/lib/privacy-notice";

/**
 * The gym reviews, edits and publishes its OWN member privacy notice here.
 * Members only ever see the published version, at /j/{slug}/privacy — the
 * "starting point, not legal advice" framing stays in this screen.
 */
export function PrivacyNoticeEditorCard({ dojoId }: { dojoId: string }) {
  const [title, setTitle] = useState(PRIVACY_NOTICE_TITLE);
  const [body, setBody] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);

  const query = useQuery({
    queryKey: ["privacy-notice", dojoId],
    queryFn: async () => {
      const [dojoRes, rowsRes] = await Promise.all([
        supabase
          .from("dojos")
          .select(
            "name, slug, contact_email, privacy_contact_email, collect_media_consent, partner_matching_enabled, retention_auto_enabled, retention_departed_months, retention_waiver_months",
          )
          .eq("id", dojoId)
          .maybeSingle(),
        supabase
          .from("dojo_privacy_notices")
          .select("id, title, body_markdown, version, is_current, published_at")
          .eq("dojo_id", dojoId)
          .order("version", { ascending: false }),
      ]);
      if (dojoRes.error) throw dojoRes.error;
      if (rowsRes.error) throw rowsRes.error;
      const rows = rowsRes.data ?? [];
      return {
        dojo: dojoRes.data as any,
        published: rows.find((r) => r.is_current) ?? null,
        draft: rows.find((r) => !r.is_current && !r.published_at) ?? null,
        maxVersion: rows.reduce((m, r) => Math.max(m, r.version), 0),
      };
    },
  });

  const dojo = query.data?.dojo;

  const generated = dojo
    ? buildPrivacyNotice({
        gymName: dojo.name ?? "",
        contactEmail: dojo.privacy_contact_email ?? dojo.contact_email ?? null,
        collectsDateOfBirth: true,
        collectMediaConsent: dojo.collect_media_consent !== false,
        partnerMatchingEnabled: !!dojo.partner_matching_enabled,
        retentionAutoEnabled: !!dojo.retention_auto_enabled,
        retentionDepartedMonths: dojo.retention_departed_months ?? null,
        retentionWaiverMonths: dojo.retention_waiver_months ?? null,
      })
    : "";

  useEffect(() => {
    if (!query.data) return;
    const source = query.data.draft ?? query.data.published;
    setTitle(source?.title ?? PRIVACY_NOTICE_TITLE);
    setBody(source?.body_markdown ?? generated);
    setContactEmail(dojo?.privacy_contact_email ?? dojo?.contact_email ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query.data]);

  async function saveContactEmail() {
    const { error } = await supabase
      .from("dojos")
      .update({ privacy_contact_email: contactEmail.trim() || null })
      .eq("id", dojoId);
    if (error) throw error;
  }

  async function saveDraft() {
    if (!query.data) return;
    setSaving(true);
    try {
      await saveContactEmail();
      const payload = { title: title.trim() || PRIVACY_NOTICE_TITLE, body_markdown: body };
      if (query.data.draft) {
        const { error } = await supabase
          .from("dojo_privacy_notices")
          .update(payload)
          .eq("id", query.data.draft.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("dojo_privacy_notices").insert({
          dojo_id: dojoId,
          version: query.data.maxVersion + 1,
          is_current: false,
          ...payload,
        });
        if (error) throw error;
      }
      toast.success("Draft saved — members still see your last published version.");
      await query.refetch();
    } catch (e: any) {
      toast.error(e?.message ?? "Could not save the draft");
    } finally {
      setSaving(false);
    }
  }

  async function publish() {
    if (!query.data) return;
    if (!body.trim()) {
      toast.error("Add the notice text before publishing.");
      return;
    }
    setPublishing(true);
    try {
      await saveContactEmail();
      const { data: auth } = await supabase.auth.getUser();
      // Only one version can be current, so stand the old one down first.
      if (query.data.published) {
        const { error } = await supabase
          .from("dojo_privacy_notices")
          .update({ is_current: false })
          .eq("id", query.data.published.id);
        if (error) throw error;
      }
      const payload = {
        title: title.trim() || PRIVACY_NOTICE_TITLE,
        body_markdown: body,
        is_current: true,
        published_at: new Date().toISOString(),
        published_by: auth.user?.id ?? null,
      };
      if (query.data.draft) {
        const { error } = await supabase
          .from("dojo_privacy_notices")
          .update(payload)
          .eq("id", query.data.draft.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("dojo_privacy_notices").insert({
          dojo_id: dojoId,
          version: query.data.maxVersion + 1,
          ...payload,
        });
        if (error) throw error;
      }
      toast.success("Published — this is now the notice your members see.");
      await query.refetch();
    } catch (e: any) {
      toast.error(e?.message ?? "Could not publish the notice");
    } finally {
      setPublishing(false);
    }
  }

  const published = query.data?.published ?? null;
  const publicUrl = dojo?.slug ? `/j/${dojo.slug}/privacy` : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <FileText className="size-4 text-brand" />
          Your member privacy notice
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {query.isLoading ? (
          <Skeleton className="h-72 w-full" />
        ) : (
          <>
            <div className="flex items-start gap-3 rounded-lg bg-amber-500/10 p-4 ring-1 ring-amber-500/30">
              <AlertTriangle className="mt-0.5 size-5 flex-none text-amber-600" />
              <div className="space-y-1 text-sm">
                <div className="font-semibold text-foreground">Draft — for your review</div>
                <p className="text-muted-foreground">{PRIVACY_NOTICE_OPERATOR_NOTE}</p>
                <p className="text-muted-foreground">
                  Your gym is the data controller for your members' information, so this is your
                  notice, not ours. It names your gym and describes only what your current settings
                  actually do.
                </p>
              </div>
            </div>

            <div className="rounded-lg border border-zinc-950/10 bg-surface p-3 text-xs">
              {published ? (
                <span className="inline-flex items-center gap-1.5 font-medium text-emerald-600">
                  <Check className="size-3.5" /> Published — version {published.version}
                  {published.published_at
                    ? ` on ${new Date(published.published_at).toLocaleDateString()}`
                    : ""}
                </span>
              ) : (
                <span className="font-medium text-muted-foreground">
                  Not published yet — your signup page tells members to contact you instead of
                  showing an unfinished notice.
                </span>
              )}
              {publicUrl && (
                <a
                  href={publicUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="ml-3 inline-flex items-center gap-1.5 font-medium text-brand-strong underline underline-offset-2"
                >
                  View the member page <ExternalLink className="size-3" />
                </a>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="privacy-contact">Contact email for data protection questions</Label>
              <Input
                id="privacy-contact"
                type="email"
                value={contactEmail}
                placeholder="privacy@yourgym.com"
                onChange={(e) => setContactEmail(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Shown to members as the address for access, correction and erasure requests.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="privacy-title">Title</Label>
              <Input id="privacy-title" value={title} onChange={(e) => setTitle(e.target.value)} />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="privacy-body">Notice text</Label>
              <Textarea
                id="privacy-body"
                rows={20}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                className="font-mono text-xs"
              />
              <p className="text-xs text-muted-foreground">
                Lines starting with <code>## </code> are headings and lines starting with{" "}
                <code>- </code> are bullet points.
              </p>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button onClick={publish} disabled={publishing || saving} className="gap-2">
                {publishing ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
                {published ? "Publish new version" : "Publish to members"}
              </Button>
              <Button variant="outline" onClick={saveDraft} disabled={publishing || saving}>
                {saving ? "Saving…" : "Save draft"}
              </Button>
              <Button
                variant="ghost"
                className="gap-2"
                disabled={publishing || saving}
                onClick={() => {
                  setBody(generated);
                  toast.success("Regenerated from your current gym settings.");
                }}
              >
                <RefreshCw className="size-4" /> Regenerate from settings
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
