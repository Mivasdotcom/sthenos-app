import { recomputeMemberRetention } from "@/lib/retention.functions";
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { MemberAvatar } from "@/components/BeltChip";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentDojo } from "@/hooks/use-current-dojo";
import { ArrowLeft } from "lucide-react";
import { useServerFn } from "@tanstack/react-start";
import { recordAttendance } from "@/lib/trial.functions";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

type MemberRow = {
  id: string;
  name: string;
  belt_color: string | null;
  belt_label: string | null;
  stripes: number | null;
  discipline: string | null;
  status: string | null;
};

type ClassRow = {
  id: string;
  name: string;
  start_time: string;
  end_time: string;
  discipline: string | null;
};

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function QuickCheckinDialog({ open, onOpenChange }: Props) {
  const { activeDojoId } = useCurrentDojo();
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [results, setResults] = useState<MemberRow[]>([]);
  const [searching, setSearching] = useState(false);
  const [selectedMember, setSelectedMember] = useState<MemberRow | null>(null);
  const [classes, setClasses] = useState<ClassRow[]>([]);
  const [classesLoading, setClassesLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [trialPrompt, setTrialPrompt] = useState<
    { classId: string | null; className: string; message: string } | null
  >(null);
  const recordFn = useServerFn(recordAttendance);

  // Reset on close
  useEffect(() => {
    if (!open) {
      setQuery("");
      setDebounced("");
      setResults([]);
      setSelectedMember(null);
      setClasses([]);
    }
  }, [open]);

  // Debounce search
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query), 300);
    return () => clearTimeout(t);
  }, [query]);

  // Search members
  useEffect(() => {
    if (!open || selectedMember || !activeDojoId) return;
    if (!debounced.trim()) {
      setResults([]);
      return;
    }
    let cancelled = false;
    setSearching(true);
    (async () => {
      const { data, error } = await supabase
        .from("members")
        .select("id, name, belt_color, belt_label, stripes, discipline, status")
        .eq("dojo_id", activeDojoId)
        .ilike("name", `%${debounced}%`)
        .in("status", ["active", "trial"])
        .limit(8);
      if (!cancelled) {
        if (error) {
          toast.error(error.message);
          setResults([]);
        } else {
          setResults((data as MemberRow[]) ?? []);
        }
        setSearching(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [debounced, open, selectedMember, activeDojoId]);

  // Load today's classes when member is picked
  useEffect(() => {
    if (!selectedMember || !activeDojoId) return;
    let cancelled = false;
    setClassesLoading(true);
    (async () => {
      const weekday = new Date().getDay();
      const { data, error } = await supabase
        .from("classes")
        .select("id, name, start_time, end_time, discipline")
        .eq("dojo_id", activeDojoId)
        .eq("weekday", weekday)
        .order("start_time");
      if (!cancelled) {
        if (error) {
          toast.error(error.message);
          setClasses([]);
        } else {
          setClasses((data as ClassRow[]) ?? []);
        }
        setClassesLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedMember, activeDojoId]);

  const fmtTime = (t: string) => t.slice(0, 5);

  async function submitCheckin(cls: ClassRow | null, override = false) {
    if (!selectedMember || !activeDojoId || submitting) return;
    setSubmitting(true);
    let res: any;
    try {
      res = await recordFn({
        data: {
          dojoId: activeDojoId,
          memberId: selectedMember.id,
          classId: cls?.id ?? null,
          override,
        },
      });
    } catch (e: any) {
      toast.error(e?.message ?? "Check-in failed");
      setSubmitting(false);
      return;
    }
    if (!res?.ok) {
      setTrialPrompt({
        classId: cls?.id ?? null,
        className: cls?.name ?? "open mat",
        message: res?.message ?? "This member's free trial is used up.",
      });
      setSubmitting(false);
      return;
    }

    void recomputeMemberRetention({
      data: { dojoId: activeDojoId, memberIds: [selectedMember.id] },
    }).catch(() => {});

    toast.success(
      `${selectedMember.name} checked in to ${cls?.name ?? "open mat"}${
        res.overridden ? " (trial override recorded)" : ""
      }`,
    );
    queryClient.invalidateQueries({ queryKey: ["members", activeDojoId] });
    queryClient.invalidateQueries({ queryKey: ["dash-revenue", activeDojoId] });
    queryClient.invalidateQueries({ queryKey: ["dash-activity", activeDojoId] });
    queryClient.invalidateQueries({ queryKey: ["trial-usage"] });

    // Reset to step 1, keep open
    setSelectedMember(null);
    setQuery("");
    setDebounced("");
    setResults([]);
    setClasses([]);
    setSubmitting(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {selectedMember ? "Select class" : "Quick Check-in"}
          </DialogTitle>
        </DialogHeader>

        {!selectedMember ? (
          <div className="space-y-3">
            <Input
              autoFocus
              placeholder="Search member by name…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <div className="max-h-72 overflow-y-auto rounded-md border">
              {searching && (
                <div className="p-3 text-sm text-muted-foreground">Searching…</div>
              )}
              {!searching && debounced && results.length === 0 && (
                <div className="p-3 text-sm text-muted-foreground">No members found.</div>
              )}
              {!searching && !debounced && (
                <div className="p-3 text-sm text-muted-foreground">Start typing to find a member.</div>
              )}
              {results.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setSelectedMember(m)}
                  className="flex w-full items-center gap-3 border-b px-3 py-2 text-left last:border-b-0 hover:bg-muted"
                >
                  <MemberAvatar name={m.name} />
                  <span className="font-medium">{m.name}</span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center gap-3 rounded-md border bg-muted/40 p-3">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => setSelectedMember(null)}
                aria-label="Back"
              >
                <ArrowLeft className="size-4" />
              </Button>
              <MemberAvatar name={selectedMember.name} />
              <span className="font-medium">{selectedMember.name}</span>
            </div>

            <div className="space-y-2">
              {classesLoading && (
                <div className="text-sm text-muted-foreground">Loading classes…</div>
              )}
              {!classesLoading && classes.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  disabled={submitting}
                  onClick={() => submitCheckin(c)}
                  className="flex w-full items-center justify-between rounded-md border p-3 text-left hover:bg-muted disabled:opacity-50"
                >
                  <div>
                    <div className="font-medium">{c.name}</div>
                    {c.discipline && (
                      <div className="text-xs text-muted-foreground">{c.discipline}</div>
                    )}
                  </div>
                  <div className="text-sm tabular-nums text-muted-foreground">
                    {fmtTime(c.start_time)} – {fmtTime(c.end_time)}
                  </div>
                </button>
              ))}
              <button
                type="button"
                disabled={submitting}
                onClick={() => submitCheckin(null)}
                className="flex w-full items-center justify-between rounded-md border border-dashed p-3 text-left hover:bg-muted disabled:opacity-50"
              >
                <span className="font-medium">No class / open mat</span>
              </button>
            </div>
          </div>
        )}
      </DialogContent>
      <AlertDialog open={!!trialPrompt} onOpenChange={(o) => !o && setTrialPrompt(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Free trial used up</AlertDialogTitle>
            <AlertDialogDescription>
              {trialPrompt?.message} Set them up on a plan to keep them training — or allow this
              one class as a coach's call. Overrides are recorded against your name.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={async () => {
                const p = trialPrompt;
                setTrialPrompt(null);
                if (!p) return;
                const cls = classes.find((c) => c.id === p.classId) ?? null;
                await submitCheckin(cls, true);
              }}
            >
              Allow this class
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
}
