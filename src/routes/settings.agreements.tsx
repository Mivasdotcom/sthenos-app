import { PUBLIC_SITE_URL } from "@/lib/site";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentDojo } from "@/hooks/use-current-dojo";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeft, Lock, Loader2, Check, FileText, Camera } from "lucide-react";
import { toast } from "sonner";
import {
  DEFAULT_MINOR_WAIVER_BODY,
  DEFAULT_MINOR_WAIVER_TITLE,
  DEFAULT_WAIVER_BODY,
  DEFAULT_WAIVER_TITLE,
} from "@/lib/waiver-defaults";
import { DEFAULT_TERMS_BODY, DEFAULT_TERMS_TITLE, versionLabel } from "@/lib/agreements";
import { WaiverTemplatePicker } from "@/components/WaiverTemplatePicker";
import { PrivacyNoticeEditorCard } from "@/components/PrivacyNoticeEditorCard";


export const Route = createFileRoute("/settings/agreements")({
  head: () => ({
    meta: [
      { title: "Member agreements \u2014 Settings \u2014 Sthenos" },
      {
        name: "description",
        content:
          "Manage the waiver, membership terms & conditions, and consent options your members read at signup.",
      },
      { property: "og:title", content: "Member agreements \u2014 Settings \u2014 Sthenos" },
      {
        property: "og:description",
        content:
          "Manage the waiver, membership terms & conditions, and consent options your members read at signup.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { property: "og:url", content: `${PUBLIC_SITE_URL}/settings/agreements` },
    ],
    links: [{ rel: "canonical", href: `${PUBLIC_SITE_URL}/settings/agreements` }],
  }),
  component: MemberAgreementsSettingsPage,
});

const EDIT_ROLES = new Set(["owner", "admin"]);

function MemberAgreementsSettingsPage() {
  const { activeDojoId, activeDojo } = useCurrentDojo();
  const role = activeDojo?.role ?? null;
  const canEdit = role ? EDIT_ROLES.has(role) : false;

  return (
    <main>
      <PageHeader
        title="Member agreements"
        subtitle="Everything a member has to read or agree to when they join — waiver, your terms & conditions, and consent options."
      />
      <div className="mx-auto max-w-4xl space-y-4 p-6">
        <Button asChild variant="ghost" size="sm" className="gap-2">
          <Link to="/settings">
            <ArrowLeft className="size-4" /> Back to settings
          </Link>
        </Button>

        {!canEdit ? (
          <Alert variant="destructive">
            <Lock className="size-4" />
            <AlertTitle>Owner or admin access required</AlertTitle>
            <AlertDescription>
              Only owners and admins can manage member agreements.
            </AlertDescription>
          </Alert>
        ) : !activeDojoId ? (
          <Skeleton className="h-64 w-full" />
        ) : (
          <div className="space-y-6">
            <WaiverCard dojoId={activeDojoId} audience="adult" />
            <WaiverCard dojoId={activeDojoId} audience="minor" />
            <TermsCard dojoId={activeDojoId} />
            <ConsentOptionsCard dojoId={activeDojoId} />
            <PrivacyNoticeEditorCard dojoId={activeDojoId} />
          </div>
        )}
      </div>
    </main>
  );
}

/* ---------------- Waiver ---------------- */

function WaiverCard({
  dojoId,
  audience,
}: {
  dojoId: string;
  audience: "adult" | "minor";
}) {
  const isMinorWaiver = audience === "minor";
  const defaultTitle = isMinorWaiver ? DEFAULT_MINOR_WAIVER_TITLE : DEFAULT_WAIVER_TITLE;
  const defaultBody = isMinorWaiver ? DEFAULT_MINOR_WAIVER_BODY : DEFAULT_WAIVER_BODY;

  const queryClient = useQueryClient();
  const [title, setTitle] = useState(defaultTitle);
  const [body, setBody] = useState(defaultBody);
  const [row, setRow] = useState<{ id: string; version: number } | null>(null);
  const [saving, setSaving] = useState(false);

  const query = useQuery({
    queryKey: ["active-waiver", dojoId, audience],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("dojo_waivers")
        .select("id, title, body_markdown, version, updated_at, audience")
        .eq("dojo_id", dojoId)
        .eq("is_current", true)
        .eq("audience", audience)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  useEffect(() => {
    if (query.data) {
      setRow({ id: query.data.id, version: query.data.version ?? 1 });
      setTitle(query.data.title ?? defaultTitle);
      setBody(query.data.body_markdown ?? defaultBody);
    } else if (query.isSuccess) {
      setRow(null);
      setTitle(defaultTitle);
      setBody(defaultBody);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query.data, query.isSuccess]);

  const changed =
    !row ||
    title.trim() !== (query.data?.title ?? "").trim() ||
    body !== (query.data?.body_markdown ?? "");

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: ["active-waiver", dojoId, audience] });
    queryClient.invalidateQueries({ queryKey: ["dojo-agreements-public"] });
    queryClient.invalidateQueries({ queryKey: ["my-agreements"] });
  }

  async function save() {
    if (body.trim().length < 10) {
      toast.error("Waiver text is too short");
      return;
    }
    setSaving(true);
    try {
      if (row) {
        const { error } = await supabase
          .from("dojo_waivers")
          .update({
            title: title.trim() || defaultTitle,
            body_markdown: body,
            version: (row.version ?? 1) + 1,
          })
          .eq("id", row.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("dojo_waivers").insert({
          dojo_id: dojoId,
          title: title.trim() || defaultTitle,
          body_markdown: body,
          is_current: true,
          audience,
        });
        if (error) throw error;
      }
      toast.success(
        "Waiver published — members who signed an older version will be asked to re-accept.",
      );
      invalidate();
    } catch (err: any) {
      toast.error(err?.message ?? "Could not save waiver");
    } finally {
      setSaving(false);
    }
  }

  async function unpublish() {
    if (!row) return;
    setSaving(true);
    try {
      const { error } = await supabase
        .from("dojo_waivers")
        .update({ is_current: false })
        .eq("id", row.id);
      if (error) throw error;
      toast.success("Minor waiver switched off — under-18s will sign the adult waiver instead.");
      invalidate();
    } catch (err: any) {
      toast.error(err?.message ?? "Could not switch off the minor waiver");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <FileText className="size-4 text-brand" />
          {isMinorWaiver ? "Minors waiver" : "Adult waiver"}
          <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
            {query.data ? versionLabel(query.data.version ?? null) : "Not published"}
          </span>
          <span className="text-xs font-normal text-muted-foreground">
            {isMinorWaiver
              ? "Optional — signed by a parent or guardian"
              : "Required at signup (18 and over)"}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {query.isLoading ? (
          <Skeleton className="h-48 w-full" />
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="max-w-xl text-sm text-muted-foreground">
                {isMinorWaiver
                  ? "Signed by a parent or guardian for members under 18. If you leave this unpublished, under-18s sign the adult waiver instead — guardian details are still collected either way."
                  : "The waiver every member aged 18 or over signs at signup."}
              </p>
              <WaiverTemplatePicker
                onInsert={(t) => {
                  setTitle(t.name);
                  setBody(t.body);
                  toast.success("Template inserted — customise it, then publish.");
                }}
              />
            </div>
            <AgreementFields
              idPrefix={isMinorWaiver ? "minor-waiver" : "waiver"}
              title={title}
              body={body}
              onTitle={setTitle}
              onBody={setBody}
              rows={14}
            />
            <SaveRow
              saving={saving}
              disabled={!changed}
              onSave={save}
              updatedAt={query.data?.updated_at ?? null}
              label={
                isMinorWaiver && !row ? "Publish minors waiver" : "Publish waiver"
              }
            />
            {isMinorWaiver && row && (
              <Button
                variant="ghost"
                size="sm"
                disabled={saving}
                onClick={unpublish}
                className="text-muted-foreground"
              >
                Switch off minors waiver
              </Button>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}


/* ---------------- Terms & Conditions ---------------- */

function TermsCard({ dojoId }: { dojoId: string }) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState(DEFAULT_TERMS_TITLE);
  const [body, setBody] = useState(DEFAULT_TERMS_BODY);
  const [row, setRow] = useState<{ id: string; version: number } | null>(null);
  const [saving, setSaving] = useState(false);

  const query = useQuery({
    queryKey: ["dojo-terms", dojoId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("dojo_terms")
        .select("id, title, body_markdown, version, updated_at")
        .eq("dojo_id", dojoId)
        .eq("is_current", true)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  useEffect(() => {
    if (query.data) {
      setRow({ id: query.data.id, version: query.data.version ?? 1 });
      setTitle(query.data.title ?? DEFAULT_TERMS_TITLE);
      setBody(query.data.body_markdown ?? "");
    } else if (query.isSuccess) {
      setRow(null);
      setTitle(DEFAULT_TERMS_TITLE);
      setBody(DEFAULT_TERMS_BODY);
    }
  }, [query.data, query.isSuccess]);

  const changed =
    !row ||
    title.trim() !== (query.data?.title ?? "").trim() ||
    body !== (query.data?.body_markdown ?? "");

  async function save() {
    setSaving(true);
    try {
      if (row) {
        const { error } = await supabase
          .from("dojo_terms")
          .update({
            title: title.trim() || DEFAULT_TERMS_TITLE,
            body_markdown: body,
            version: (row.version ?? 1) + 1,
          })
          .eq("id", row.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("dojo_terms").insert({
          dojo_id: dojoId,
          title: title.trim() || DEFAULT_TERMS_TITLE,
          body_markdown: body,
          is_current: true,
        });
        if (error) throw error;
      }
      toast.success(
        body.trim().length === 0
          ? "Terms cleared — they won't be shown at signup."
          : "Terms & conditions published.",
      );
      queryClient.invalidateQueries({ queryKey: ["dojo-terms", dojoId] });
      queryClient.invalidateQueries({ queryKey: ["dojo-agreements-public"] });
      queryClient.invalidateQueries({ queryKey: ["my-agreements"] });
    } catch (err: any) {
      toast.error(err?.message ?? "Could not save terms");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <FileText className="size-4 text-brand" />
          Terms &amp; conditions
          <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
            {versionLabel(query.data?.version ?? null)}
          </span>
          <span className="text-xs font-normal text-muted-foreground">
            Optional — leave blank to hide
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {query.isLoading ? (
          <Skeleton className="h-48 w-full" />
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              Your gym's own membership rules — cancellation notice period, class etiquette, late
              payment, guest rules. Members must tick to agree at signup when this is set.
            </p>
            <AgreementFields
              idPrefix="terms"
              title={title}
              body={body}
              onTitle={setTitle}
              onBody={setBody}
              rows={16}
            />
            <SaveRow
              saving={saving}
              disabled={!changed}
              onSave={save}
              updatedAt={query.data?.updated_at ?? null}
              label="Publish terms"
            />
          </>
        )}
      </CardContent>
    </Card>
  );
}

/* ---------------- Consent options ---------------- */

function ConsentOptionsCard({ dojoId }: { dojoId: string }) {
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);

  const query = useQuery({
    queryKey: ["dojo-consent-options", dojoId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("dojos")
        .select("id, collect_media_consent")
        .eq("id", dojoId)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const enabled = query.data?.collect_media_consent !== false;

  async function toggle(next: boolean) {
    setSaving(true);
    try {
      const { error } = await supabase
        .from("dojos")
        .update({ collect_media_consent: next })
        .eq("id", dojoId);
      if (error) throw error;
      toast.success(
        next
          ? "Media consent will be collected at signup."
          : "Media consent is now hidden everywhere for this gym.",
      );
      queryClient.invalidateQueries({ queryKey: ["dojo-consent-options", dojoId] });
      queryClient.invalidateQueries({ queryKey: ["dojo-agreements-public"] });
      queryClient.invalidateQueries({ queryKey: ["my-agreements"] });
    } catch (err: any) {
      toast.error(err?.message ?? "Could not update consent options");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Camera className="size-4 text-brand" />
          Consent options
        </CardTitle>
      </CardHeader>
      <CardContent>
        {query.isLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : (
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="text-sm font-medium">Collect media &amp; marketing consent</div>
              <p className="mt-1 text-xs text-muted-foreground">
                Shows an optional, unticked photo/video consent checkbox at signup and lets members
                change it later in their portal. Turn off and the checkbox is hidden everywhere for
                this gym.
              </p>
            </div>
            <Switch checked={enabled} disabled={saving} onCheckedChange={(v) => toggle(v)} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/* ---------------- Shared bits ---------------- */

function AgreementFields({
  idPrefix,
  title,
  body,
  onTitle,
  onBody,
  rows,
}: {
  idPrefix: string;
  title: string;
  body: string;
  onTitle: (v: string) => void;
  onBody: (v: string) => void;
  rows: number;
}) {
  return (
    <>
      <div className="space-y-1.5">
        <label htmlFor={`${idPrefix}-title`} className="text-sm font-medium">
          Title
        </label>
        <input
          id={`${idPrefix}-title`}
          value={title}
          onChange={(e) => onTitle(e.target.value)}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary"
        />
      </div>
      <div className="space-y-1.5">
        <label htmlFor={`${idPrefix}-body`} className="text-sm font-medium">
          Body
        </label>
        <textarea
          id={`${idPrefix}-body`}
          value={body}
          onChange={(e) => onBody(e.target.value)}
          rows={rows}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary"
        />
      </div>
    </>
  );
}

function SaveRow({
  saving,
  disabled,
  onSave,
  updatedAt,
  label,
}: {
  saving: boolean;
  disabled: boolean;
  onSave: () => void;
  updatedAt: string | null;
  label: string;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-xs text-muted-foreground">
        {updatedAt
          ? `Last updated ${new Date(updatedAt).toLocaleDateString()}`
          : "Not published yet"}
        . Saving changes publishes a new version.
      </p>
      <Button onClick={onSave} disabled={saving || disabled} className="gap-2">
        {saving ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
        {label}
      </Button>
    </div>
  );
}
