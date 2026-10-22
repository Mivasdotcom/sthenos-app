import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

type Props = {
  /** Query keys to invalidate. If omitted, invalidates all queries. */
  queryKeys?: ReadonlyArray<ReadonlyArray<unknown>>;
  /** Auto-refresh interval in ms. Default 30s. Set 0 to disable. */
  intervalMs?: number;
  label?: string;
};

export function RefreshControl({ queryKeys, intervalMs = 30_000, label = "Refresh" }: Props) {
  const qc = useQueryClient();
  const [spinning, setSpinning] = useState(false);
  const [lastAt, setLastAt] = useState<Date | null>(null);

  const run = async () => {
    setSpinning(true);
    try {
      if (queryKeys && queryKeys.length) {
        await Promise.all(queryKeys.map((k) => qc.invalidateQueries({ queryKey: k as unknown[] })));
      } else {
        await qc.invalidateQueries();
      }
      setLastAt(new Date());
    } finally {
      setTimeout(() => setSpinning(false), 400);
    }
  };

  useEffect(() => {
    if (!intervalMs) return;
    const id = setInterval(() => {
      if (document.visibilityState === "visible") void run();
    }, intervalMs);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, JSON.stringify(queryKeys)]);

  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      {lastAt && <span className="hidden sm:inline">Updated {lastAt.toLocaleTimeString()}</span>}
      <Button variant="outline" size="sm" onClick={run} disabled={spinning}>
        <RefreshCw className={`h-3.5 w-3.5 ${spinning ? "animate-spin" : ""}`} />
        <span className="ml-1.5">{label}</span>
      </Button>
    </div>
  );
}
