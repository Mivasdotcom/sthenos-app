/**
 * Email broadcasts to the whole roster or a saved segment: compose, segments
 * and send history.
 *
 * Used to be its own "Marketing" page beside "Communications". Merged in as
 * the Broadcasts tab of Communications, because a coach shouldn't have to know
 * that one-to-one messages and group emails live under different menus.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { AudienceFilterBuilder } from "@/components/AudienceFilterBuilder";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { listSegments, saveSegment, deleteSegment, previewAudience } from "@/lib/audience.functions";
import { listBroadcasts, sendBroadcast } from "@/lib/marketing.functions";
import { getEmailSettings, saveEmailSettings } from "@/lib/email-settings.functions";
import type { AudienceFilter } from "@/lib/audience";
import { describeFilter, EMPTY_FILTER, BUILT_IN_AUDIENCES } from "@/lib/audience";
import { personalize, hasUnresolvedMergeFields } from "@/lib/marketing-personalize";

import { Mail, Send, FolderPlus, Trash2, Users, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCurrentDojo } from "@/hooks/use-current-dojo";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";

export function BroadcastsPanel() {
  return (
    <Tabs defaultValue="compose">
      <TabsList>
        <TabsTrigger value="compose" className="gap-2"><Mail className="size-3.5" /> Compose</TabsTrigger>
        <TabsTrigger value="segments" className="gap-2"><FolderPlus className="size-3.5" /> Segments</TabsTrigger>
        <TabsTrigger value="history" className="gap-2"><Send className="size-3.5" /> History</TabsTrigger>
      </TabsList>
      <TabsContent value="compose" className="mt-8"><ComposePanel /></TabsContent>
      <TabsContent value="segments" className="mt-8"><SegmentsPanel /></TabsContent>
      <TabsContent value="history" className="mt-8"><HistoryPanel /></TabsContent>
    </Tabs>
  );
}

// ───────────── Compose ─────────────

function ComposePanel() {
  const qc = useQueryClient();
  const { activeDojoId } = useCurrentDojo();
  const previewFn = useServerFn(previewAudience);
  const sendFn = useServerFn(sendBroadcast);
  const listSeg = useServerFn(listSegments);
  const getSettings = useServerFn(getEmailSettings);

  const { data: segData } = useQuery({ queryKey: ["segments"], queryFn: () => listSeg() });
  const { data: settingsData } = useQuery({
    queryKey: ["email-settings", activeDojoId],
    enabled: !!activeDojoId,
    queryFn: () => getSettings({ data: { dojoId: activeDojoId! } }),
  });

  const [name, setName] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("<p>Hey {{name}},</p>\n<p>Write your message here. You can use <strong>{{name}}</strong>, <strong>{{discipline}}</strong>, and <strong>{{belt}}</strong> for personalization.</p>");
  const [fromName, setFromName] = useState<string>("");
  const [segmentId, setSegmentId] = useState<string | "all" | "custom">("all");
  const [customFilter, setCustomFilter] = useState<AudienceFilter>(EMPTY_FILTER);

  const effectiveFromName = fromName || settingsData?.settings.from_name || "";
  const fromAddress = settingsData?.sending.fromAddress ?? "";

  const activeFilter: AudienceFilter = useMemo(() => {
    if (segmentId === "all") return { exclude_marketing_opt_out: true };
    if (segmentId === "custom") return { ...customFilter, exclude_marketing_opt_out: true };
    // Built-ins carry a prefix so their ids can never collide with a saved
    // segment's.
    if (segmentId.startsWith("bi:")) {
      const b = BUILT_IN_AUDIENCES.find((x) => `bi:${x.id}` === segmentId);
      return { ...(b?.filter ?? {}), exclude_marketing_opt_out: true };
    }
    const seg = segData?.segments.find((s: any) => s.id === segmentId);
    return { ...(seg?.filter ?? {}), exclude_marketing_opt_out: true };
  }, [segmentId, customFilter, segData]);

  const preview = useQuery({
    queryKey: ["preview-audience", activeFilter],
    queryFn: () => previewFn({ data: { filter: activeFilter } }),
  });

  // Preview against a REAL member from the selected audience, using the same
  // substitution the send performs, so "Hey {{name}}," is never what staff
  // approve and never what a member receives.
  const sampleCandidates = useMemo(
    () => (preview.data?.members ?? []).filter((m: any) => !!m.email),
    [preview.data],
  );
  const [sampleId, setSampleId] = useState<string | null>(null);
  const sample = useMemo(
    () => sampleCandidates.find((m: any) => m.id === sampleId) ?? sampleCandidates[0] ?? null,
    [sampleCandidates, sampleId],
  );
  const previewSubject = personalize(subject, sample ?? {});
  const previewBody = personalize(body, sample ?? {});
  const previewHasPlaceholders = hasUnresolvedMergeFields(previewBody) || hasUnresolvedMergeFields(previewSubject);



  const send = useMutation({
    mutationFn: async () => sendFn({
      data: {
        dojoId: activeDojoId!,
        name: name || subject,
        subject,
        body_html: body,
        from_name: effectiveFromName,
        // A built-in audience is a filter, not a saved segment: sending its id
        // as segment_id would look up a row that does not exist, and an email
        // meant for four people on a trial would go to the whole roster.
        segment_id:
          segmentId !== "all" && segmentId !== "custom" && !segmentId.startsWith("bi:")
            ? segmentId
            : undefined,
        filter:
          segmentId === "custom"
            ? customFilter
            : segmentId.startsWith("bi:")
              ? activeFilter
              : undefined,
      },
    }),
    onSuccess: (r) => {
      if (r.pendingVerification) {
        toast.warning("Email pending domain verification — recipients were logged but not delivered yet.");
      } else {
        toast.success(`Broadcast sent · ${r.sent}/${r.recipients} delivered${r.failed ? ` · ${r.failed} failed` : ""}`);
        if (r.error && r.failed > 0) toast.error(r.error.slice(0, 120));
      }
      qc.invalidateQueries({ queryKey: ["broadcasts"] });
    },
    onError: (e: any) => toast.error(e?.message ?? "Send failed"),
  });

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
      <div className="space-y-6 rounded-xl border border-zinc-200 bg-white p-6">
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Campaign name (internal)">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Q1 Winback Push" />
          </Field>
          <Field label={`From name (default: ${settingsData?.settings.from_name ?? ""})`}>
            <Input value={fromName} onChange={(e) => setFromName(e.target.value)} placeholder={settingsData?.settings.from_name ?? ""} />
          </Field>
        </div>
        <Field label="Subject">
          <Input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="See you on the mat this week 🥋" />
        </Field>
        <Field label="Body (HTML — use {{name}}, {{discipline}}, {{belt}})">
          <Textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={12}
            className="font-mono text-sm"
          />
        </Field>
        <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-4">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Preview {sample ? "as a real recipient" : ""}
            </div>
            {sampleCandidates.length > 0 && (
              <select
                className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs"
                value={sample?.id ?? ""}
                onChange={(e) => setSampleId(e.target.value)}
                aria-label="Preview as member"
              >
                {sampleCandidates.map((m: any) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            )}
          </div>
          <div className="rounded-md bg-white p-4">
            <div className="mb-3 border-b border-zinc-100 pb-2">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Subject</div>
              <div className="text-sm font-medium">{previewSubject || <em className="text-muted-foreground">No subject</em>}</div>
            </div>
            <div
              className="text-sm prose prose-sm max-w-none"
              dangerouslySetInnerHTML={{ __html: previewBody || "<em>Empty</em>" }}
            />
            <hr className="my-4 border-zinc-200" />
            <p className="text-[11px] text-muted-foreground">
              You received this email because of an action on {effectiveFromName}.{" "}
              <span className="underline">Unsubscribe from these emails</span>.
            </p>

          </div>
          {!sample && (
            <p className="mt-2 text-xs text-muted-foreground">
              No matching member with an email yet — merge fields will fill in once the audience has recipients.
            </p>
          )}
          {previewHasPlaceholders && (
            <p className="mt-2 text-xs text-amber-600">
              Unknown merge field found. Only {"{{name}}"}, {"{{discipline}}"} and {"{{belt}}"} are substituted — anything
              else is sent literally.
            </p>
          )}
        </div>

        <div className="flex justify-end">
          <Button
            size="lg"
            disabled={!subject || !body || send.isPending || (preview.data?.withEmail ?? 0) === 0}
            onClick={() => send.mutate()}
          >
            <Send className="mr-2 size-4" />
            {send.isPending ? "Sending…" : `Send to ${preview.data?.withEmail ?? 0} member${preview.data?.withEmail === 1 ? "" : "s"}`}
          </Button>
        </div>
      </div>

      <div className="space-y-4">
        <div className="rounded-xl border border-zinc-200 bg-white p-5">
          <div className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Audience</div>
          <div className="space-y-2">
            <SegmentOption active={segmentId === "all"} onClick={() => setSegmentId("all")}>
              <Users className="size-3.5" /> Whole roster
            </SegmentOption>
            {/* The groups a gym actually writes to. Without them, the only
                thing anyone could send without first building a filter was an
                email to everybody -- which is why nobody sent anything. */}
            {BUILT_IN_AUDIENCES.map((b) => (
              <SegmentOption
                key={b.id}
                active={segmentId === `bi:${b.id}`}
                onClick={() => setSegmentId(`bi:${b.id}`)}
              >
                <Users className="size-3.5 shrink-0" />
                <span className="min-w-0">
                  {b.label}
                  <span className="block text-[11px] font-normal text-muted-foreground">
                    {b.hint}
                  </span>
                </span>
              </SegmentOption>
            ))}
            {segData?.segments.map((s: any) => (
              <SegmentOption key={s.id} active={segmentId === s.id} onClick={() => setSegmentId(s.id)}>
                <FolderPlus className="size-3.5" /> {s.name}
              </SegmentOption>
            ))}
            <SegmentOption active={segmentId === "custom"} onClick={() => setSegmentId("custom")}>
              <span className="inline-block size-3.5 rounded-sm border border-current" /> Custom filter
            </SegmentOption>
          </div>
          {segmentId === "custom" && (
            <div className="mt-4 border-t border-zinc-200 pt-4">
              <AudienceFilterBuilder value={customFilter} onChange={setCustomFilter} />
            </div>
          )}
        </div>

        <div className="rounded-xl border border-zinc-200 bg-white p-5">
          <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Will reach</div>
          <div className="mt-2 font-display text-3xl font-semibold tabular-nums">
            {preview.data?.withEmail ?? 0}
            <span className="ml-2 text-base font-normal text-muted-foreground">/ {preview.data?.total ?? 0} matched</span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{describeFilter(activeFilter)}</p>
          {(preview.data?.total ?? 0) > (preview.data?.withEmail ?? 0) && (
            <div className="mt-3 flex items-start gap-2 rounded-md bg-amber-100 p-2 text-xs text-amber-800">
              <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
              <span>{(preview.data?.total ?? 0) - (preview.data?.withEmail ?? 0)} matched members have no email on file.</span>
            </div>
          )}
        </div>

        <SenderCard previewFrom={`${effectiveFromName} <${fromAddress}>`} />

      </div>
    </div>
  );
}

function SegmentOption({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 rounded-md border px-3 py-2 text-left text-sm transition-colors",
        active ? "border-brand bg-brand/5 font-semibold text-zinc-900" : "border-zinc-200 hover:border-zinc-300 hover:bg-zinc-50",
      )}
    >
      {children}
    </button>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <Label className="text-xs">{label}</Label>
      {children}
    </div>
  );
}

function SenderCard({ previewFrom }: { previewFrom: string }) {
  const qc = useQueryClient();
  const { activeDojoId } = useCurrentDojo();
  const getSettings = useServerFn(getEmailSettings);
  const saveSettings = useServerFn(saveEmailSettings);
  const { data } = useQuery({
    queryKey: ["email-settings", activeDojoId],
    enabled: !!activeDojoId,
    queryFn: () => getSettings({ data: { dojoId: activeDojoId! } }),
  });

  const [editing, setEditing] = useState(false);
  const [fromName, setFromName] = useState("");
  const [fromAddress, setFromAddress] = useState("");

  const startEdit = () => {
    setFromName(data?.settings.from_name ?? "");
    setFromAddress(data?.settings.from_address ?? "");
    setEditing(true);
  };

  const save = useMutation({
    mutationFn: () => saveSettings({ data: { from_name: fromName, from_address: fromAddress, dojoId: activeDojoId! } }),
    onSuccess: () => {
      toast.success("Sender saved");
      qc.invalidateQueries({ queryKey: ["email-settings"] });
      setEditing(false);
    },
    onError: (e: any) => toast.error(e?.message ?? "Save failed"),
  });

  const verified = data?.sending.verified ?? false;

  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-5">
      <div className="mb-3 flex items-center justify-between">
        <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Sender</div>
        {!editing && (
          <Button variant="ghost" size="sm" onClick={startEdit}>Edit</Button>
        )}
      </div>
      {!editing ? (
        <>
          <div className="text-sm text-zinc-700 break-all">{previewFrom}</div>
          {data?.settings.from_address ? (
            <div className="mt-1 text-xs text-muted-foreground break-all">Replies go to {data.settings.from_address}</div>
          ) : null}
          {!verified && (
            <div className="mt-3 flex items-start gap-2 rounded-md bg-amber-100 p-2 text-xs text-amber-800">
              <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
              <span>Email pending domain verification. Broadcasts are logged and will send automatically once {data?.sending.domain ?? "the sending domain"} is verified.</span>
            </div>
          )}
        </>
      ) : (
        <div className="space-y-3">
          <Field label="From name">
            <Input value={fromName} onChange={(e) => setFromName(e.target.value)} placeholder="Your gym" />
          </Field>
          <Field label="Reply-to address">
            <Input value={fromAddress} onChange={(e) => setFromAddress(e.target.value)} placeholder="hello@yourgym.com" />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>Cancel</Button>
            <Button size="sm" disabled={save.isPending} onClick={() => save.mutate()}>Save</Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Emails send from <code>{data?.sending.fromAddress ?? ""}</code> with your gym's name, and replies go to this address.
          </p>
        </div>
      )}
    </div>
  );
}


function SegmentsPanel() {
  const qc = useQueryClient();
  const { activeDojoId } = useCurrentDojo();
  const listFn = useServerFn(listSegments);
  const saveFn = useServerFn(saveSegment);
  const deleteFn = useServerFn(deleteSegment);
  const { data } = useQuery({ queryKey: ["segments", activeDojoId], queryFn: () => listFn(), enabled: !!activeDojoId });

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<any | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [filter, setFilter] = useState<AudienceFilter>(EMPTY_FILTER);

  const startNew = () => {
    setEditing(null);
    setName("");
    setDescription("");
    setFilter(EMPTY_FILTER);
    setOpen(true);
  };
  const startEdit = (s: any) => {
    setEditing(s);
    setName(s.name);
    setDescription(s.description ?? "");
    setFilter(s.filter ?? EMPTY_FILTER);
    setOpen(true);
  };

  const save = useMutation({
    mutationFn: () => saveFn({ data: { id: editing?.id, dojoId: activeDojoId!, name, description, filter } }),
    onSuccess: () => {
      toast.success("Segment saved");
      qc.invalidateQueries({ queryKey: ["segments"] });
      setOpen(false);
    },
  });
  const del = useMutation({
    mutationFn: (id: string) => deleteFn({ data: { id } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["segments"] }),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">Reusable audience folders. Use them in broadcasts and workflows.</p>
        <Button onClick={startNew}><FolderPlus className="mr-2 size-4" /> New segment</Button>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        {data?.segments.map((s: any) => (
          <div key={s.id} className="rounded-xl border border-zinc-200 bg-white p-5">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="font-semibold">{s.name}</div>
                {s.description && <p className="mt-1 text-sm text-muted-foreground">{s.description}</p>}
                <p className="mt-2 text-xs text-zinc-600">{describeFilter(s.filter)}</p>
              </div>
              <div className="flex gap-1">
                <Button variant="ghost" size="sm" onClick={() => startEdit(s)}>Edit</Button>
                <Button variant="ghost" size="sm" onClick={() => del.mutate(s.id)}><Trash2 className="size-4" /></Button>
              </div>
            </div>
          </div>
        ))}
        {!data?.segments?.length && (
          <div className="col-span-2 rounded-xl border border-dashed border-zinc-300 bg-zinc-50 p-10 text-center text-sm text-muted-foreground">
            No segments yet. Create one to reuse audience filters across campaigns and workflows.
          </div>
        )}
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit segment" : "New segment"}</DialogTitle>
            <DialogDescription>Build a reusable audience filter.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
            <Field label="Description (optional)"><Input value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
            <AudienceFilterBuilder value={filter} onChange={setFilter} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={() => save.mutate()} disabled={!name || save.isPending}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ───────────── History ─────────────

function HistoryPanel() {
  const { activeDojoId } = useCurrentDojo();
  const fn = useServerFn(listBroadcasts);
  const { data } = useQuery({
    queryKey: ["broadcasts", activeDojoId],
    enabled: !!activeDojoId,
    queryFn: () => fn({ data: { dojoId: activeDojoId! } }),
  });
  return (
    <div className="rounded-xl border border-zinc-200 bg-white">
      <table className="w-full text-sm">
        <thead className="border-b border-zinc-200 bg-zinc-50/50 text-xs uppercase tracking-wider text-muted-foreground">
          <tr>
            <th className="px-4 py-3 text-left">Campaign</th>
            <th className="px-4 py-3 text-left">Subject</th>
            <th className="px-4 py-3 text-right">Sent</th>
            <th className="px-4 py-3 text-right">Failed</th>
            <th className="px-4 py-3 text-left">Status</th>
            <th className="px-4 py-3 text-left">When</th>
          </tr>
        </thead>
        <tbody>
          {data?.broadcasts.map((b: any) => (
            <tr key={b.id} className="border-b border-zinc-100 last:border-0">
              <td className="px-4 py-3 font-medium">{b.name}</td>
              <td className="px-4 py-3 text-zinc-700">{b.subject}</td>
              <td className="px-4 py-3 text-right tabular-nums">{b.sent_count}/{b.recipient_count}</td>
              <td className="px-4 py-3 text-right tabular-nums text-red-700">{b.failed_count || ""}</td>
              <td className="px-4 py-3">
                <span className={cn(
                  "rounded-full px-2 py-0.5 text-xs font-medium",
                  b.status === "sent" && "bg-emerald-100 text-emerald-800",
                  b.status === "failed" && "bg-red-100 text-red-800",
                  b.status === "sending" && "bg-amber-100 text-amber-800",
                  b.status === "draft" && "bg-zinc-100 text-zinc-700",
                )}>{b.status}</span>
              </td>
              <td className="px-4 py-3 text-zinc-500">{b.sent_at ? formatDistanceToNow(new Date(b.sent_at), { addSuffix: true }) : "—"}</td>
            </tr>
          ))}
          {!data?.broadcasts?.length && (
            <tr><td colSpan={6} className="px-4 py-12 text-center text-sm text-muted-foreground">No broadcasts sent yet.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
