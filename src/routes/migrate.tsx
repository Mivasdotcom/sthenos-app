import { PUBLIC_SITE_URL } from "@/lib/site";
import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/integrations/supabase/client";
import { parseCSV } from "@/lib/csv";
import {
  PRESETS,
  MEMBER_FIELDS,
  ATTENDANCE_FIELDS,
  autoMap,
  extractStripesFromBeltString,
  normalizeBeltColor,
  normalizeDate,
  normalizeDiscipline,
  normalizePlan,
  normalizeStatus,
  normalizeStripes,
  type Entity,
  type Preset,
} from "@/lib/crm-presets";
import { toast } from "sonner";
import { Upload, CheckCircle2, AlertCircle, ArrowRight, Database } from "lucide-react";
import { useCurrentDojo } from "@/hooks/use-current-dojo";

export const Route = createFileRoute("/migrate")({
  head: () => ({
    meta: [
      { title: "Migrate from another CRM \u2014 Sthenos" },
      { name: "description", content: "Import members and attendance from GymDesk, Kicksite, Zen Planner, or any CSV." },
      { property: "og:title", content: "Migrate from another CRM \u2014 Sthenos" },
      { property: "og:description", content: "Import members and attendance from GymDesk, Kicksite, Zen Planner, or any CSV." },
      { property: "og:url", content: `${PUBLIC_SITE_URL}/migrate` },
      { name: "twitter:title", content: "Migrate from another CRM \u2014 Sthenos" },
      { name: "twitter:description", content: "Import members and attendance from GymDesk, Kicksite, Zen Planner, or any CSV." },
    ],
    links: [
      { rel: "canonical", href: `${PUBLIC_SITE_URL}/migrate` },
    ],
  }),
  component: MigratePage,
});

function MigratePage() {
  const [presetId, setPresetId] = useState<string>("gymdesk");
  const preset = PRESETS.find((p) => p.id === presetId)!;
  const [entity, setEntity] = useState<Entity>("members");
  const { activeDojoId } = useCurrentDojo();

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <PageHeader
        title="Migrate from another CRM"
        subtitle="Bring members and attendance from GymDesk, BJJ Link, Maat, Kicksite, Zen Planner, or any CSV export."
      />

      {!activeDojoId && (
        <div className="mt-6 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          Select a dojo before importing.
        </div>
      )}

      <div className="mt-8 grid gap-4 md:grid-cols-4">
        {PRESETS.map((p) => (
          <button
            key={p.id}
            onClick={() => setPresetId(p.id)}
            className={`rounded-lg border p-4 text-left transition ${
              presetId === p.id
                ? "border-primary bg-primary/5 ring-1 ring-primary"
                : "border-zinc-200 hover:border-zinc-400"
            }`}
          >
            <div className="flex items-center gap-2 font-semibold">
              <Database className="size-4" />
              {p.name}
            </div>
            <div className="mt-1 text-xs text-muted-foreground">{p.description}</div>
          </button>
        ))}
      </div>

      {activeDojoId && (
        <Tabs value={entity} onValueChange={(v) => setEntity(v as Entity)} className="mt-8">
          <TabsList>
            <TabsTrigger value="members">Members</TabsTrigger>
            <TabsTrigger value="attendances">Attendance</TabsTrigger>
          </TabsList>
          <TabsContent value="members" className="mt-4">
            <Importer key={`${presetId}-members`} preset={preset} entity="members" dojoId={activeDojoId} />
          </TabsContent>
          <TabsContent value="attendances" className="mt-4">
            <Importer key={`${presetId}-attendances`} preset={preset} entity="attendances" dojoId={activeDojoId} />
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}

function Importer({ preset, entity, dojoId }: { preset: Preset; entity: Entity; dojoId: string }) {

  const fields = entity === "members" ? MEMBER_FIELDS : ATTENDANCE_FIELDS;
  const [fileName, setFileName] = useState<string>("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<Record<string, string>[]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<{ ok: number; failed: number; skipped?: number; errors: string[] } | null>(null);

  async function onFile(file: File) {
    const text = await file.text();
    const { headers, rows } = parseCSV(text);
    setFileName(file.name);
    setHeaders(headers);
    setRows(rows);
    setMapping(autoMap(preset, entity, headers));
    setResult(null);
  }

  const preview = useMemo(() => rows.slice(0, 5), [rows]);
  const missingRequired = fields.filter((f) => f.required && !mapping[f.key]);

  async function runImport() {
    if (!dojoId) {
      toast.error("No active dojo selected");
      return;
    }
    setImporting(true);
    setResult(null);
    try {
      if (entity === "members") await importMembers(rows, mapping, dojoId, setResult);
      else await importAttendances(rows, mapping, dojoId, setResult);

    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Import failed");
    } finally {
      setImporting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          Import {entity === "members" ? "members" : "attendance"} from {preset.name}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <label className="flex cursor-pointer items-center justify-center gap-3 rounded-lg border-2 border-dashed border-zinc-300 p-6 text-sm text-muted-foreground hover:border-primary">
          <Upload className="size-5" />
          {fileName ? `Loaded: ${fileName} (${rows.length} rows)` : "Click to upload a CSV file"}
          <input
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
          />
        </label>

        {headers.length > 0 && (
          <>
            <div>
              <h3 className="mb-3 text-sm font-semibold">Column mapping</h3>
              <div className="grid gap-3 md:grid-cols-2">
                {fields.map((f) => (
                  <div key={f.key} className="space-y-1">
                    <label className="flex items-center gap-2 text-xs font-medium">
                      {f.label}
                      {f.required && <Badge variant="outline" className="text-[10px]">required</Badge>}
                      {mapping[f.key] && <CheckCircle2 className="size-3.5 text-emerald-600" />}
                    </label>
                    <select
                      value={mapping[f.key] ?? ""}
                      onChange={(e) =>
                        setMapping((m) => ({ ...m, [f.key]: e.target.value }))
                      }
                      className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
                    >
                      <option value="">— skip —</option>
                      {headers.map((h) => (
                        <option key={h} value={h}>{h}</option>
                      ))}
                    </select>
                    {f.hint && <p className="text-[10px] text-muted-foreground">{f.hint}</p>}
                  </div>
                ))}
              </div>
            </div>

            <div>
              <h3 className="mb-3 text-sm font-semibold">Preview (first 5 rows)</h3>
              <div className="overflow-x-auto rounded-md border">
                <table className="w-full text-xs">
                  <thead className="bg-muted">
                    <tr>
                      {fields.map((f) => (
                        <th key={f.key} className="px-2 py-1.5 text-left font-medium">{f.label}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {preview.map((r, i) => (
                      <tr key={i} className="border-t">
                        {fields.map((f) => (
                          <td key={f.key} className="px-2 py-1.5">
                            {mapping[f.key] ? r[mapping[f.key]] || <span className="text-muted-foreground">—</span> : <span className="text-muted-foreground">—</span>}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {missingRequired.length > 0 && (
              <div className="flex items-start gap-2 rounded-md bg-amber-100 p-3 text-xs text-amber-900">
                <AlertCircle className="mt-0.5 size-4 shrink-0" />
                Map the required fields: {missingRequired.map((f) => f.label).join(", ")}
              </div>
            )}

            <div className="flex items-center justify-end gap-3">
              <Button
                onClick={runImport}
                disabled={importing || missingRequired.length > 0}
              >
                {importing ? "Importing…" : `Import ${rows.length} rows`}
                <ArrowRight className="ml-2 size-4" />
              </Button>
            </div>
          </>
        )}

        {result && (
          <div className="rounded-md border bg-muted/30 p-4 text-sm">
            <div className="flex items-center gap-2 font-semibold">
              <CheckCircle2 className="size-4 text-emerald-600" />
              {result.ok} imported · {result.skipped ?? 0} skipped (already exist) · {result.failed} failed
            </div>
            {result.errors.length > 0 && (
              <ul className="mt-2 max-h-40 list-disc space-y-1 overflow-y-auto pl-5 text-xs text-muted-foreground">
                {result.errors.slice(0, 20).map((e, i) => <li key={i}>{e}</li>)}
              </ul>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

async function importMembers(
  rows: Record<string, string>[],
  mapping: Record<string, string>,
  dojoId: string,
  setResult: (r: { ok: number; failed: number; skipped: number; errors: string[] }) => void,
) {
  const errors: string[] = [];
  const payload: any[] = [];

  const { data: dojoPlans } = await supabase
    .from("dojo_plans")
    .select("name")
    .eq("dojo_id", dojoId);
  const planNames = (dojoPlans ?? []).map((p) => p.name);

  rows.forEach((r, idx) => {
    const get = (k: string) => (mapping[k] ? r[mapping[k]] ?? "" : "");
    const name = mapping["first_name"]
      ? `${get("first_name")} ${get("last_name")}`.trim()
      : get("name").trim();
    const disc = normalizeDiscipline(get("discipline"));
    if (!name) return errors.push(`Row ${idx + 2}: missing name`);
    if (!disc) return errors.push(`Row ${idx + 2}: unknown discipline "${get("discipline")}"`);

    const email = get("email").toLowerCase().trim();

    const beltRaw = get("belt_color");
    const beltColor = normalizeBeltColor(beltRaw, disc);
    const stripes = mapping["stripes"]
      ? normalizeStripes(get("stripes"))
      : (mapping["belt_color"] ? extractStripesFromBeltString(beltRaw, disc) : 0);

    payload.push({
      dojo_id: dojoId,
      name,
      email: get("email") || null,
      phone: get("phone") || null,
      discipline: disc,
      belt_color: beltColor,
      belt_label: get("belt_label") || `${beltColor[0].toUpperCase()}${beltColor.slice(1)} Belt`,
      stripes,
      status: normalizeStatus(get("status")),
      plan: normalizePlan(get("plan"), planNames),
      joined_at: normalizeDate(get("joined_at"))?.slice(0, 10) ?? new Date().toISOString().slice(0, 10),
      last_seen_at: normalizeDate(get("last_seen_at")),
    });
  });

  // Deduplicate by email against the database
  const existingEmails = new Set<string>();
  if (payload.some(p => p.email)) {
    const emails = payload.map(p => p.email).filter(Boolean);
    const { data: existing } = await supabase
      .from("members")
      .select("email")
      .eq("dojo_id", dojoId)
      .in("email", emails);
    (existing ?? []).forEach(m => {
      if (m.email) existingEmails.add(m.email.toLowerCase());
    });
  }
  const deduped = payload.filter(p => {
    if (p.email && existingEmails.has(p.email.toLowerCase())) {
      errors.push(`Skipped duplicate: ${p.email}`);
      return false;
    }
    return true;
  });

  let ok = 0;
  for (let i = 0; i < deduped.length; i += 200) {
    const chunk = deduped.slice(i, i + 200);
    const { error, data } = await supabase.from("members").insert(chunk).select("id");
    if (error) errors.push(`Batch ${i / 200 + 1}: ${error.message}`);
    else ok += data?.length ?? chunk.length;
  }
  const skipped = rows.length - ok - deduped.length;
  const failed = rows.length - ok - skipped;
  setResult({ ok, failed, skipped, errors });
  if (ok) toast.success(`Imported ${ok} members${skipped ? ` · ${skipped} skipped` : ""}`);
}

async function importAttendances(
  rows: Record<string, string>[],
  mapping: Record<string, string>,
  activeDojoId: string,
  setResult: (r: { ok: number; failed: number; skipped: number; errors: string[] }) => void,
) {
  const errors: string[] = [];
  // Build email -> member_id map scoped to this dojo
  const { data: members, error: mErr } = await supabase
    .from("members")
    .select("id,email")
    .eq("dojo_id", activeDojoId);
  if (mErr) throw mErr;
  const byEmail = new Map<string, string>();
  for (const m of members ?? []) {
    if (m.email) byEmail.set(m.email.toLowerCase().trim(), m.id);
  }

  const payload: any[] = [];
  rows.forEach((r, idx) => {
    const get = (k: string) => (mapping[k] ? r[mapping[k]] ?? "" : "");
    const email = get("member_email").toLowerCase().trim();
    const ts = normalizeDate(get("checked_in_at"));
    if (!email) return errors.push(`Row ${idx + 2}: missing email`);
    const memberId = byEmail.get(email);
    if (!memberId) return errors.push(`Row ${idx + 2}: no member with email ${email}`);
    if (!ts) return errors.push(`Row ${idx + 2}: invalid check-in date "${get("checked_in_at")}"`);
    payload.push({ dojo_id: activeDojoId, member_id: memberId, checked_in_at: ts });
  });

  let ok = 0;
  for (let i = 0; i < payload.length; i += 500) {
    const chunk = payload.slice(i, i + 500);
    const { error, data } = await supabase.from("attendances").insert(chunk).select("id");
    if (error) errors.push(`Batch ${i / 500 + 1}: ${error.message}`);
    else ok += data?.length ?? chunk.length;
  }
  setResult({ ok, failed: rows.length - ok, skipped: 0, errors });
  if (ok) toast.success(`Imported ${ok} attendance records`);
}
