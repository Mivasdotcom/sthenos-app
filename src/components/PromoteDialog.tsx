import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { BeltChip } from "@/components/BeltChip";
import { supabase } from "@/integrations/supabase/client";
import { getBeltColors, RANK_LABELS, type BeltColor } from "@/lib/belt-colors";

interface MemberLite {
  id: string;
  dojo_id: string;
  name: string;
  discipline: string;
  belt_color: BeltColor;
  belt_label: string;
  stripes: number;
  dan: number | null;
}

interface Props {
  member: MemberLite | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function colorsFor(d: string): BeltColor[] {
  return getBeltColors(d);
}

function defaultLabel(color: BeltColor, d: string): string {
  const base = RANK_LABELS[color] ?? (color[0].toUpperCase() + color.slice(1));
  if (color === "beginner") return "Beginner";
  const NO_BELT = new Set(["novice", "intermediate", "advanced", "competitor"]);
  if (NO_BELT.has(color)) return base;
  const suffix = d === "Muay Thai" ? "Prajied" : "Belt";
  return `${base} ${suffix}`;
}

export function PromoteDialog({ member, open, onOpenChange }: Props) {
  const qc = useQueryClient();
  const [toColor, setToColor] = useState<BeltColor>("white");
  const [toLabel, setToLabel] = useState("");
  const [toStripes, setToStripes] = useState(0);
  const [toDan, setToDan] = useState<number | "">("");
  const [awardedBy, setAwardedBy] = useState("");
  const [note, setNote] = useState("");

  useEffect(() => {
    if (member && open) {
      setToColor(member.belt_color);
      setToLabel(member.belt_label);
      setToStripes(member.stripes);
      setToDan(member.dan ?? "");
      setAwardedBy("");
      setNote("");
    }
  }, [member, open]);


  const isBJJ = member?.discipline === "BJJ";
  const showDan = member && !isBJJ && (toColor === "black" || toColor === "red");

  const mutation = useMutation({
    mutationFn: async () => {
      if (!member) throw new Error("No member selected");
      const toDanVal = showDan && toDan !== "" ? Number(toDan) : null;

      const { error: insErr } = await supabase.from("promotions").insert({
        dojo_id: member.dojo_id,
        member_id: member.id,
        discipline: member.discipline,
        from_color: member.belt_color,
        from_label: member.belt_label,
        from_stripes: member.stripes,
        from_dan: member.dan,
        to_color: toColor,
        to_label: toLabel,
        to_stripes: toStripes,
        to_dan: toDanVal,
        awarded_by: awardedBy || null,
        note: note || null,
      });
      if (insErr) throw insErr;

      const { error: updErr } = await supabase
        .from("members")
        .update({
          belt_color: toColor,
          belt_label: toLabel,
          stripes: toStripes,
          dan: toDanVal,
        })
        .eq("id", member.id);
      if (updErr) throw updErr;
    },
    onSuccess: () => {
      toast.success(`${member?.name} promoted to ${toLabel}`);
      qc.invalidateQueries({ queryKey: ["members"] });
      qc.invalidateQueries({ queryKey: ["promotions"] });
      onOpenChange(false);
      // Reset for next open
      setToLabel("");
      setToColor("white");
      setToStripes(0);
      setToDan("");
      setAwardedBy("");
      setNote("");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (!member) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Promote {member.name}</DialogTitle>
          <DialogDescription>
            Record a rank change. This logs to the promotions history and updates the member.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="rounded-md border bg-muted/30 p-3">
            <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Current rank
            </div>
            <BeltChip
              belt={{
                color: member.belt_color,
                label: member.belt_label,
                stripes: member.stripes,
                dan: member.dan ?? undefined,
              }}
              discipline={member.discipline}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="color">Belt color</Label>
              <Select
                value={toColor}
                onValueChange={(v: BeltColor) => {
                  setToColor(v);
                  setToLabel(defaultLabel(v, member.discipline));
                  setToStripes(0);
                }}
              >
                <SelectTrigger id="color"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {colorsFor(member.discipline).map((c) => (
                    <SelectItem key={c} value={c}>{RANK_LABELS[c] ?? (c[0].toUpperCase() + c.slice(1))}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="label">Label</Label>
              <Input id="label" value={toLabel} onChange={(e) => setToLabel(e.target.value)} />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="stripes">
                {isBJJ ? "Stripes (0–4)" : "Stripes"}
              </Label>
              <Input
                id="stripes"
                type="number"
                min={0}
                max={isBJJ ? 4 : 9}
                value={toStripes}
                onChange={(e) => setToStripes(Math.max(0, Number(e.target.value) || 0))}
              />
            </div>
            {showDan && (
              <div className="space-y-1.5">
                <Label htmlFor="dan">Dan</Label>
                <Input
                  id="dan"
                  type="number"
                  min={1}
                  max={10}
                  value={toDan}
                  onChange={(e) => setToDan(e.target.value === "" ? "" : Number(e.target.value))}
                />
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="by">Awarded by (optional)</Label>
            <Input id="by" value={awardedBy} onChange={(e) => setAwardedBy(e.target.value)} placeholder="Prof. Aranha" />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="note">Note (optional)</Label>
            <Textarea id="note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Reason for promotion" />
          </div>

          <div className="rounded-md border bg-muted/30 p-3">
            <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              New rank
            </div>
            <BeltChip
              belt={{
                color: toColor,
                label: toLabel || defaultLabel(toColor, member.discipline),
                stripes: toStripes,
                dan: showDan && toDan !== "" ? Number(toDan) : undefined,
              }}
              discipline={member.discipline}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button
            className="bg-brand text-brand-foreground hover:bg-brand/90"
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending || !toLabel}
          >
            {mutation.isPending ? "Saving…" : "Promote"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
