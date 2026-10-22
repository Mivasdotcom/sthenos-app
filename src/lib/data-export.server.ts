/**
 * Full per-dojo data export (GDPR portability): every table the gym owns,
 * as CSV files inside a single zip. Strictly scoped to one dojo_id.
 */
import { zipSync, strToU8 } from "fflate";

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s: string;
  if (typeof v === "object") s = JSON.stringify(v);
  else s = String(v);
  if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCSV(rows: Record<string, unknown>[]): string {
  if (!rows.length) return "";
  const headers = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const lines = [headers.join(",")];
  for (const r of rows) lines.push(headers.map((h) => csvCell(r[h])).join(","));
  return lines.join("\r\n") + "\r\n";
}

const DOJO_TABLES = [
  "members",
  "member_status_history",
  "member_subscriptions",
  "member_payment_methods",
  "membership_pauses",
  "attendances",
  "class_bookings",
  "classes",
  "dojo_class_types",
  "promotions",
  "member_waivers",
  "waiver_templates",
  "dojo_waivers",
  "dojo_terms",
  "invoices",
  "payments",
  "cash_payments",
  "refunds",
  "disputes",
  "dunning_notices",
  "manual_revenue",
  "dojo_plans",
  "plan_price_changes",
  "family_groups",
  "family_discount_tiers",
  "conversations",
  "messages",
  "marketing_broadcasts",
  "retention_interventions",
  "dojo_overheads",
  "dojo_memberships",
] as const;

export async function buildDojoExport(
  admin: any,
  dojoId: string,
): Promise<{ files: Record<string, string>; counts: Record<string, number> }> {
  const files: Record<string, string> = {};
  const counts: Record<string, number> = {};

  const dojoRes = await admin.from("dojos").select("*").eq("id", dojoId);
  files["dojo.csv"] = toCSV((dojoRes.data ?? []) as any[]);

  let invoiceIds: string[] = [];

  for (const table of DOJO_TABLES) {
    const rows: any[] = [];
    // page through, so large gyms export completely
    for (let from = 0; ; from += 1000) {
      const { data, error } = await admin
        .from(table)
        .select("*")
        .eq("dojo_id", dojoId)
        .range(from, from + 999);
      if (error) throw new Error(`${table}: ${error.message}`);
      rows.push(...((data ?? []) as any[]));
      if (!data || data.length < 1000) break;
    }
    if (table === "invoices") invoiceIds = rows.map((r) => r.id);
    counts[table] = rows.length;
    files[`${table}.csv`] = toCSV(rows);
  }

  // invoice_line_items is scoped by invoice, not dojo
  const lineItems: any[] = [];
  for (let i = 0; i < invoiceIds.length; i += 200) {
    const chunk = invoiceIds.slice(i, i + 200);
    if (!chunk.length) break;
    const { data, error } = await admin
      .from("invoice_line_items")
      .select("*")
      .in("invoice_id", chunk);
    if (error) throw new Error(`invoice_line_items: ${error.message}`);
    lineItems.push(...((data ?? []) as any[]));
  }
  counts["invoice_line_items"] = lineItems.length;
  files["invoice_line_items.csv"] = toCSV(lineItems);

  files["README.txt"] =
    `Sthenos data export\r\nGenerated: ${new Date().toISOString()}\r\nDojo: ${dojoId}\r\n\r\n` +
    `One CSV per dataset. Row counts:\r\n` +
    Object.entries(counts)
      .map(([k, v]) => `  ${k}: ${v}`)
      .join("\r\n") +
    "\r\n";

  return { files, counts };
}

export function zipBase64(files: Record<string, string>): string {
  const entries: Record<string, Uint8Array> = {};
  for (const [name, content] of Object.entries(files)) entries[name] = strToU8(content);
  const zipped = zipSync(entries, { level: 6 });
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < zipped.length; i += chunk) {
    binary += String.fromCharCode(...zipped.subarray(i, i + chunk));
  }
  return btoa(binary);
}
