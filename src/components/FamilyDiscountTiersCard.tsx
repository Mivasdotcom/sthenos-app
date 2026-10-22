import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus, Trash2, Users } from "lucide-react";
import {
  getFamilyPricingConfig,
  saveFamilyPricingConfig,
} from "@/lib/family-pricing.functions";
import {
  DEFAULT_FAMILY_TIERS,
  pricingModeExplainer,
  type FamilyDiscountTier,
  type FamilyPricingMode,
} from "@/lib/family-pricing";

type Draft = { min_members: string; discount_percent: string };

const toDraft = (t: FamilyDiscountTier): Draft => ({
  min_members: String(t.min_members),
  discount_percent: String(t.discount_percent),
});

/** Owner/admin editor for the gym's family pricing model and discount tiers. */
export function FamilyDiscountTiersCard({ dojoId }: { dojoId: string }) {
  const qc = useQueryClient();
  const getCfg = useServerFn(getFamilyPricingConfig);
  const saveCfg = useServerFn(saveFamilyPricingConfig);

  const cfgQ = useQuery({
    queryKey: ["family-pricing-config", dojoId],
    enabled: !!dojoId,
    queryFn: () => getCfg({ data: { dojoId } }),
  });

  const [mode, setMode] = useState<FamilyPricingMode>("tiered");
  const [rows, setRows] = useState<Draft[]>(DEFAULT_FAMILY_TIERS.map(toDraft));

  useEffect(() => {
    if (!cfgQ.data) return;
    setMode(cfgQ.data.mode);
    setRows(cfgQ.data.tiers.map(toDraft));
  }, [cfgQ.data]);

  const save = useMutation({
    mutationFn: () =>
      saveCfg({
        data: {
          dojoId,
          mode,
          tiers: rows
            .filter((r) => r.min_members.trim() !== "")
            .map((r) => ({
              min_members: Math.floor(Number(r.min_members)),
              discount_percent: Number(r.discount_percent || "0"),
            })),
        },
      }),
    onSuccess: () => {
      toast.success("Family pricing saved");
      qc.invalidateQueries({ queryKey: ["family-pricing-config"] });
      qc.invalidateQueries({ queryKey: ["family-quote"] });
    },
    onError: (e: Error) => toast.error(e.message ?? "Could not save family pricing"),
  });

  const sorted = [...rows].sort(
    (a, b) => Number(a.min_members) - Number(b.min_members),
  );
  const highest = sorted.length ? sorted[sorted.length - 1] : null;

  return (
    <section className="rounded-xl bg-card p-6 ring-1 ring-black/5">
      <div className="flex items-center gap-2">
        <Users className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">Family pricing</h2>
      </div>

      <div className="mt-4 max-w-xs space-y-1.5">
        <Label>Pricing model</Label>
        <Select value={mode} onValueChange={(v) => setMode(v as FamilyPricingMode)}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="tiered">Tiered discount (recommended)</SelectItem>
            <SelectItem value="flat">Flat family plan price</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <p className="mt-2 max-w-2xl text-xs text-muted-foreground">
        {pricingModeExplainer(mode)}
      </p>

      {mode === "tiered" && (
        <>
          <div className="mt-5 overflow-hidden rounded-lg ring-1 ring-black/5">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-zinc-950/5 bg-zinc-50/60">
                  <th className="px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Family size (from)
                  </th>
                  <th className="px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Discount %
                  </th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-950/5">
                {rows.map((r, idx) => (
                  <tr key={idx}>
                    <td className="px-3 py-2">
                      <Input
                        type="number"
                        min={2}
                        step={1}
                        className="h-8 w-24"
                        value={r.min_members}
                        onChange={(e) =>
                          setRows((prev) =>
                            prev.map((p, i) =>
                              i === idx ? { ...p, min_members: e.target.value } : p,
                            ),
                          )
                        }
                      />
                    </td>
                    <td className="px-3 py-2">
                      <Input
                        type="number"
                        min={0}
                        max={100}
                        step={1}
                        className="h-8 w-24"
                        value={r.discount_percent}
                        onChange={(e) =>
                          setRows((prev) =>
                            prev.map((p, i) =>
                              i === idx
                                ? { ...p, discount_percent: e.target.value }
                                : p,
                            ),
                          )
                        }
                      />
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 text-xs"
                        onClick={() =>
                          setRows((prev) => prev.filter((_, i) => i !== idx))
                        }
                      >
                        <Trash2 className="size-3.5" /> Remove
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-3 flex items-center gap-3">
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                setRows((prev) => [
                  ...prev,
                  {
                    min_members: String(
                      Math.max(
                        2,
                        ...prev.map((p) => Number(p.min_members) || 1),
                      ) + 1,
                    ),
                    discount_percent: "0",
                  },
                ])
              }
            >
              <Plus className="size-4" /> Add tier
            </Button>
            <span className="text-xs text-muted-foreground">
              Each tier applies from that family size upwards
              {highest
                ? `, so ${highest.min_members} or more members get ${Number(highest.discount_percent) || 0}%.`
                : "."}
            </span>
          </div>

          <p className="mt-3 max-w-2xl text-xs text-muted-foreground">
            The discount applies to the sum of every family member's own plan price.
            Example: adult Monthly + child Kids = the two prices added together, then a
            family of 2 discount taken off. The payer is charged that total as one
            subscription; the others stay covered and are never charged separately.
          </p>
        </>
      )}

      <div className="mt-5">
        <Button
          size="sm"
          className="bg-brand text-brand-foreground hover:bg-brand/90"
          disabled={save.isPending}
          onClick={() => save.mutate()}
        >
          {save.isPending ? "Saving…" : "Save family pricing"}
        </Button>
      </div>
    </section>
  );
}
