import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Download, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { exportAllDojoData } from "@/lib/data-export.functions";

export function DataExportCard({
  dojoId,
  canExport,
}: {
  dojoId: string | null;
  canExport: boolean;
}) {
  const run = useServerFn(exportAllDojoData);
  const [lastCounts, setLastCounts] = useState<Record<string, number> | null>(null);

  const mutation = useMutation({
    mutationFn: async () => {
      if (!dojoId) throw new Error("No active dojo");
      return run({ data: { dojoId } });
    },
    onSuccess: (res) => {
      const bytes = Uint8Array.from(atob(res.base64), (c) => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: "application/zip" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = res.filename;
      a.click();
      URL.revokeObjectURL(url);
      setLastCounts(res.counts);
      toast.success("Export downloaded");
    },
    onError: (e: Error) => toast.error(e.message || "Export failed"),
  });

  const total = lastCounts
    ? Object.values(lastCounts).reduce((a, b) => a + b, 0)
    : 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Export all data</CardTitle>
        <CardDescription>
          Download everything this gym holds — members and contact details, status, plans,
          disciplines, belts and grading history, attendance and bookings, waivers and consents
          with versions and timestamps, billing, payments (including cash) and refunds, family
          relationships, and communications history. One zip of CSV files, no request and no
          waiting.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Button onClick={() => mutation.mutate()} disabled={!canExport || mutation.isPending}>
          {mutation.isPending ? (
            <>
              <Loader2 className="mr-2 size-4 animate-spin" /> Gathering your data…
            </>
          ) : (
            <>
              <Download className="mr-2 size-4" /> Export all data (CSV zip)
            </>
          )}
        </Button>
        {!canExport && (
          <p className="text-xs text-muted-foreground">
            Only the gym owner or an admin can export data.
          </p>
        )}
        {lastCounts && (
          <p className="text-xs text-muted-foreground">
            Last export: {total.toLocaleString()} rows across{" "}
            {Object.keys(lastCounts).length} datasets.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
