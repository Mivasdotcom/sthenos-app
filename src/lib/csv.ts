// Tiny CSV parser — handles quoted fields, commas, and escaped quotes.
export function parseCSV(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const lines: string[][] = [];
  let cur: string[] = [];
  let field = "";
  let inQuotes = false;
  const src = text.replace(/\r\n?/g, "\n");

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"' && src[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') { inQuotes = false; }
      else { field += c; }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") { cur.push(field); field = ""; }
      else if (c === "\n") { cur.push(field); lines.push(cur); cur = []; field = ""; }
      else field += c;
    }
  }
  if (field.length || cur.length) { cur.push(field); lines.push(cur); }

  const nonEmpty = lines.filter((l) => l.some((c) => c.trim() !== ""));
  if (!nonEmpty.length) return { headers: [], rows: [] };
  const headers = nonEmpty[0].map((h) => h.trim());
  const rows = nonEmpty.slice(1).map((cells) => {
    const r: Record<string, string> = {};
    headers.forEach((h, i) => { r[h] = (cells[i] ?? "").trim(); });
    return r;
  });
  return { headers, rows };
}
