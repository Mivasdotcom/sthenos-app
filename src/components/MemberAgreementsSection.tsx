import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "sonner";
import { FileText, ShieldCheck, ChevronDown, AlertTriangle } from "lucide-react";
import { MEDIA_CONSENT_HINT, isMinor } from "@/lib/consent";
import { isUnder18 } from "@/lib/minors";
import { hasTerms, isOutOfDate, versionLabel } from "@/lib/agreements";
import { useServerFn } from "@tanstack/react-start";
import { getPublicPrivacyNotice } from "@/lib/privacy.functions";

/**
 * Database-level guard messages must never reach a member who was doing
 * something legitimate. Translate the known ones and tell them what to do.
 */
function friendlyAcceptError(raw?: string | null): string {
  const msg = (raw ?? "").toLowerCase();
  if (msg.includes("only update their own") || msg.includes("must be recorded through")) {
    return "We couldn't save your acceptance just now. Please refresh and try again — if it keeps happening, ask your gym to record it for you.";
  }
  if (msg.includes("not allowed") || msg.includes("member not found")) {
    return "This portal isn't linked to your membership yet. Ask your gym to check the email address on your record.";
  }
  if (msg.includes("not authenticated")) {
    return "Your session expired — please sign in again.";
  }
  if (msg.includes("type your full name")) {
    return "Please type your full name to sign the waiver.";
  }
  return raw || "Could not record your acceptance";
}

type Doc = {
  id: string;
  version: number;
  title: string;
  body_markdown: string;
  updated_at: string | null;
} | null;

export function MemberAgreementsSection({
  member,
  onSaved,
}: {
  member: any;
  onSaved: () => void;
}) {
  const dojoId = member.dojo_id as string;
  const getPrivacyNotice = useServerFn(getPublicPrivacyNotice);

  const { data } = useQuery({
    queryKey: ["my-agreements", dojoId, member.date_of_birth ?? null],
    enabled: !!dojoId,
    queryFn: async () => {
      const [waiverRes, termsRes, dojoRes] = await Promise.all([
        supabase
          .from("dojo_waivers")
          .select("id, version, title, body_markdown, updated_at, audience")
          .eq("dojo_id", dojoId)
          .eq("is_current", true),
        supabase
          .from("dojo_terms")
          .select("id, version, title, body_markdown, updated_at")
          .eq("dojo_id", dojoId)
          .eq("is_current", true)
          .maybeSingle(),
        supabase.from("dojos").select("id, slug, collect_media_consent").eq("id", dojoId).maybeSingle(),
      ]);
      // Under-18s see the gym's minor waiver when it publishes one.
      const waivers = (waiverRes.data ?? []) as any[];
      const adult = waivers.find((w) => (w.audience ?? "adult") === "adult") ?? null;
      const minorDoc = waivers.find((w) => w.audience === "minor") ?? null;
      const forMember = isUnder18(member.date_of_birth ?? null)
        ? (minorDoc ?? adult)
        : adult;
      return {
        waiver: (forMember ?? null) as Doc,
        terms: (termsRes.data ?? null) as Doc,
        collectMediaConsent: dojoRes.data?.collect_media_consent !== false,
        slug: (dojoRes.data as any)?.slug ?? null,
      };
    },
  });

  // Members are entitled to their GYM's notice (the gym is the controller),
  // and only once the gym has actually published it.
  const privacy = useQuery({
    queryKey: ["public-privacy-notice", data?.slug ?? null],
    enabled: !!data?.slug,
    queryFn: () => getPrivacyNotice({ data: { slug: data!.slug as string } }),
    retry: false,
  });

  const waiver = data?.waiver ?? null;
  const terms = data?.terms ?? null;
  const termsSet = hasTerms(terms);

  const waiverStale = isOutOfDate(waiver?.version, member.waiver_version_accepted);
  const termsStale = termsSet && isOutOfDate(terms?.version, member.terms_version_accepted);
  const needsReview = (!!waiver && waiverStale) || termsStale;

  const [signedName, setSignedName] = useState<string>(member.name ?? "");
  const [agreeWaiver, setAgreeWaiver] = useState(false);
  const [agreeTerms, setAgreeTerms] = useState(false);

  const reaccept = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc("accept_my_agreements", {
        p_member_id: member.id,
        p_signed_name: signedName.trim(),
        p_accept_waiver: !!waiver && waiverStale && agreeWaiver,
        p_accept_terms: !!termsStale && agreeTerms,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Thanks — your agreements are up to date.");
      setAgreeWaiver(false);
      setAgreeTerms(false);
      onSaved();
    },
    onError: (e: any) => toast.error(friendlyAcceptError(e?.message)),
  });

  const canSubmit =
    ((waiver && waiverStale && agreeWaiver) || (termsStale && agreeTerms)) &&
    (!(waiver && waiverStale && agreeWaiver) || signedName.trim().length >= 2);

  return (
    <section className="rounded-xl bg-card p-6 ring-1 ring-black/5">
      <div className="mb-4 flex items-center gap-2">
        <ShieldCheck className="size-4 text-brand" />
        <h2 className="font-display text-base font-medium">My agreements</h2>
      </div>

      {needsReview && (
        <div className="mb-5 space-y-4 rounded-lg border border-amber-500/30 bg-amber-500/5 p-4">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 size-4 flex-none text-amber-600" />
            <div className="text-sm">
              <div className="font-medium">Your gym published an update</div>
              <p className="mt-1 text-xs text-muted-foreground">
                Please review and accept the latest version. You can keep using your portal in the
                meantime.
              </p>
            </div>
          </div>

          {waiver && waiverStale && (
            <div className="space-y-3">
              <div className="flex items-start gap-3">
                <Checkbox
                  id="reaccept-waiver"
                  checked={agreeWaiver}
                  onCheckedChange={(v) => setAgreeWaiver(Boolean(v))}
                  className="mt-0.5"
                />
                <Label htmlFor="reaccept-waiver" className="text-sm font-normal leading-snug">
                  I have read and agree to the latest waiver ({versionLabel(waiver.version)}).
                </Label>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="reaccept-name">Signature (type your full name)</Label>
                <Input
                  id="reaccept-name"
                  value={signedName}
                  onChange={(e) => setSignedName(e.target.value)}
                  placeholder="Type your full legal name"
                />
              </div>
            </div>
          )}

          {termsStale && terms && (
            <div className="flex items-start gap-3">
              <Checkbox
                id="reaccept-terms"
                checked={agreeTerms}
                onCheckedChange={(v) => setAgreeTerms(Boolean(v))}
                className="mt-0.5"
              />
              <Label htmlFor="reaccept-terms" className="text-sm font-normal leading-snug">
                I have read and agree to the latest terms &amp; conditions (
                {versionLabel(terms.version)}).
              </Label>
            </div>
          )}

          <Button
            size="sm"
            disabled={!canSubmit || reaccept.isPending}
            onClick={() => reaccept.mutate()}
          >
            {reaccept.isPending ? "Saving…" : "Accept updates"}
          </Button>
        </div>
      )}

      <div className="space-y-3">
        <AgreementDisclosure
          doc={waiver}
          fallbackTitle="Waiver"
          acceptedVersion={member.waiver_version_accepted ?? null}
          acceptedAt={member.waiver_signed_at ?? null}
          stale={!!waiver && waiverStale}
        />
        {termsSet && (
          <AgreementDisclosure
            doc={terms}
            fallbackTitle="Terms & conditions"
            acceptedVersion={member.terms_version_accepted ?? null}
            acceptedAt={member.terms_accepted_at ?? null}
            stale={termsStale}
          />
        )}
      </div>

      {privacy.data?.notice && privacy.data.dojo.slug && (
        <a
          href={`/j/${privacy.data.dojo.slug}/privacy`}
          target="_blank"
          rel="noreferrer"
          className="mt-4 inline-block text-xs font-medium text-brand-strong underline underline-offset-2"
        >
          How your data is used — read your gym's privacy notice
        </a>
      )}

      {data?.collectMediaConsent && <MediaConsentRow member={member} onSaved={onSaved} />}
    </section>
  );
}

function AgreementDisclosure({
  doc,
  fallbackTitle,
  acceptedVersion,
  acceptedAt,
  stale,
}: {
  doc: Doc;
  fallbackTitle: string;
  acceptedVersion: number | null;
  acceptedAt: string | null;
  stale: boolean;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="rounded-lg border border-zinc-950/10 bg-surface p-4">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-start justify-between gap-3 text-left"
      >
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
            <FileText className="size-4 text-muted-foreground" />
            {doc?.title ?? fallbackTitle}
            {stale && (
              <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-700">
                Update available
              </span>
            )}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {acceptedVersion == null && !acceptedAt
              ? "Not yet accepted"
              : `Accepted ${versionLabel(acceptedVersion)}${
                  acceptedAt ? ` on ${new Date(acceptedAt).toLocaleDateString()}` : ""
                }`}
            {doc ? ` · current ${versionLabel(doc.version)}` : ""}
          </p>
        </div>
        <ChevronDown
          className={`mt-0.5 size-4 flex-none text-muted-foreground transition-transform ${
            open ? "rotate-180" : ""
          }`}
        />
      </button>
      {open && (
        <div className="mt-3 max-h-64 overflow-y-auto whitespace-pre-wrap border-t border-border pt-3 text-sm text-muted-foreground">
          {doc?.body_markdown?.trim() || "Your gym hasn't published this document yet."}
        </div>
      )}
    </div>
  );
}

function MediaConsentRow({ member, onSaved }: { member: any; onSaved: () => void }) {
  const minor = isMinor(member.date_of_birth ?? null);
  const consented = member.media_consent === true;

  const toggle = useMutation({
    mutationFn: async (next: boolean) => {
      const { error } = await supabase.rpc("set_my_media_consent", {
        p_member_id: member.id,
        p_consent: next,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Media consent updated");
      onSaved();
    },
    onError: (e: any) => toast.error(e.message ?? "Failed to update consent"),
  });

  return (
    <div className="mt-6 space-y-3 border-t border-border pt-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-sm font-medium">Photos and video</div>
          <p className="mt-1 text-xs text-muted-foreground">
            {consented
              ? "You've agreed to your gym using photos and training footage of you for social media and marketing."
              : "You have not agreed to your gym using photos and training footage of you for marketing."}{" "}
            {MEDIA_CONSENT_HINT}
          </p>
          {minor && (
            <p className="mt-1 text-xs font-medium text-amber-600">
              Member is under 18 — a parent or guardian must make this choice.
            </p>
          )}
          {member.media_consent_at && (
            <p className="mt-1 text-[11px] text-muted-foreground">
              Last updated {new Date(member.media_consent_at).toLocaleDateString()}
            </p>
          )}
        </div>
        <Button
          size="sm"
          variant={consented ? "outline" : "default"}
          disabled={toggle.isPending}
          onClick={() => toggle.mutate(!consented)}
        >
          {toggle.isPending ? "Saving…" : consented ? "Withdraw consent" : "Give consent"}
        </Button>
      </div>
    </div>
  );
}
