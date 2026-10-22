import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { AlertTriangle, Clock, Loader2, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { BLOCKER_LABELS, monthsLabel, type RetentionBlocker } from "@/lib/retention-policy";
import {
  getRetentionHistory,
  getRetentionPolicy,
  getRetentionSchedule,
  runRetentionNow,
  setRetentionHold,
  updateRetentionPolicy,
} from "@/lib/data-retention.functions";

const fmtDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "—";

/**
 * Data retention: how long records of departed members and signed waivers are
 * kept before their personal details are removed. Waivers get their own,
 * longer clock on purpose — see the copy in the card.
 */
export function DataRetentionCard({
  dojoId,
  canEdit,
}: {
  dojoId: string | null;
  canEdit: boolean;
}) {
  const qc = useQueryClient();
  const getPolicy = useServerFn(getRetentionPolicy);
  const savePolicy = useServerFn(updateRetentionPolicy);
  const getSchedule = useServerFn(getRetentionSchedule);
  const getHistory = useServerFn(getRetentionHistory);
  const runNow = useServerFn(runRetentionNow);
  const setHold = useServerFn(setRetentionHold);

  const { data: policy } = useQuery({
    queryKey: ["retention-policy", dojoId],
    enabled: !!dojoId,
    queryFn: () => getPolicy({ data: { dojoId: dojoId! } }),
  });
  const { data: schedule, isLoading: scheduleLoading } = useQuery({
    queryKey: ["retention-schedule", dojoId],
    enabled: !!dojoId,
    queryFn: () => getSchedule({ data: { dojoId: dojoId! } }),
  });
  const { data: history } = useQuery({
    queryKey: ["retention-history", dojoId],
    enabled: !!dojoId,
    queryFn: () => getHistory({ data: { dojoId: dojoId! } }),
  });

  const [autoEnabled, setAutoEnabled] = useState(false);
  const [keepMembers, setKeepMembers] = useState(true);
  const [memberMonths, setMemberMonths] = useState("24");
  const [keepWaivers, setKeepWaivers] = useState(true);
  const [waiverMonths, setWaiverMonths] = useState("84");
  const [noticeDays, setNoticeDays] = useState("14");
  const [holdFor, setHoldFor] = useState<{ id: string; name: string; hold: boolean } | null>(null);
  const [holdReason, setHoldReason] = useState("");

  useEffect(() => {
    if (!policy) return;
    setAutoEnabled(policy.autoEnabled);
    setKeepMembers(policy.departedMonths != null);
    setMemberMonths(String(policy.departedMonths ?? 24));
    setKeepWaivers(policy.waiverMonths != null);
    setWaiverMonths(String(policy.waiverMonths ?? 84));
    setNoticeDays(String(policy.noticeDays));
  }, [policy]);

  const departedMonths = keepMembers ? Math.max(1, Math.round(Number(memberMonths) || 24)) : null;
  const waiverMonthsValue = keepWaivers ? Math.max(1, Math.round(Number(waiverMonths) || 84)) : null;

  const save = useMutation({
    mutationFn: () =>
      savePolicy({
        data: {
          dojoId: dojoId!,
          autoEnabled,
          departedMonths,
          waiverMonths: waiverMonthsValue,
          noticeDays: Math.max(0, Math.round(Number(noticeDays) || 0)),
        },
      }),
    onSuccess: () => {
      toast.success("Retention policy saved");
      qc.invalidateQueries({ queryKey: ["retention-policy"] });
      qc.invalidateQueries({ queryKey: ["retention-schedule"] });
    },
    onError: (e: any) => toast.error(e?.message ?? "Could not save"),
  });

  const run = useMutation({
    mutationFn: () => runNow({ data: { dojoId: dojoId! } }),
    onSuccess: (res: any) => {
      toast.success(
        `Retention run finished: ${res.anonymised} record(s) anonymised, ${res.skipped} kept back, ${res.waivers} waiver(s) scrubbed.`,
      );
      qc.invalidateQueries({ queryKey: ["retention-schedule"] });
      qc.invalidateQueries({ queryKey: ["retention-history"] });
      qc.invalidateQueries({ queryKey: ["members"] });
    },
    onError: (e: any) => toast.error(e?.message ?? "Retention run failed"),
  });

  const hold = useMutation({
    mutationFn: () =>
      setHold({
        data: {
          dojoId: dojoId!,
          memberId: holdFor!.id,
          hold: holdFor!.hold,
          reason: holdReason,
        },
      }),
    onSuccess: () => {
      toast.success(holdFor?.hold ? "Record excluded from anonymisation" : "Exclusion removed");
      setHoldFor(null);
      setHoldReason("");
      qc.invalidateQueries({ queryKey: ["retention-schedule"] });
    },
    onError: (e: any) => toast.error(e?.message ?? "Could not update"),
  });

  const dirty =
    !!policy &&
    (autoEnabled !== policy.autoEnabled ||
      departedMonths !== policy.departedMonths ||
      waiverMonthsValue !== policy.waiverMonths ||
      Math.round(Number(noticeDays) || 0) !== policy.noticeDays);

  const dueNow = schedule?.dueNow ?? [];
  const dueSoon = schedule?.dueSoon ?? [];
  const blocked = schedule?.blocked ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <ShieldCheck className="h-4 w-4" /> Data retention
        </CardTitle>
        <CardDescription>
          How long you keep records of people who have left. Holding personal data longer than you
          need to is itself a data-protection failing, so set a period and the app will honour it.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-5">
        {/* What happens, in plain terms */}
        <div className="rounded-lg bg-muted/50 p-3 text-xs text-muted-foreground">
          <p className="font-medium text-foreground">What happens at the end of the period</p>
          <p className="mt-1">
            Records are <strong>anonymised, not deleted</strong>. Name, email, phone, date of birth,
            guardian details, message history and saved cards are removed, and their portal login is
            closed.
          </p>
          <p className="mt-1">
            <strong>Kept regardless:</strong> invoices, payments and refunds (without personal
            details) so your revenue history and tax records stay intact, plus attendance counts,
            belt and discipline, and the dates they joined and left.
          </p>
        </div>

        <div className="flex items-center justify-between rounded-lg border border-zinc-950/5 p-3">
          <div>
            <div className="text-sm font-medium">Anonymise old records automatically</div>
            <div className="text-xs text-muted-foreground">
              Runs nightly. Off means nothing is ever removed automatically and you decide case by
              case.
            </div>
          </div>
          <Switch checked={autoEnabled} onCheckedChange={setAutoEnabled} disabled={!canEdit} />
        </div>

        {/* Member records */}
        <div className="space-y-3 rounded-lg border border-zinc-950/5 p-3">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-medium">Members who have left</div>
              <div className="text-xs text-muted-foreground">
                Cancelled or lapsed members. The clock starts the day their membership ends.
              </div>
            </div>
            <Switch checked={keepMembers} onCheckedChange={setKeepMembers} disabled={!canEdit} />
          </div>
          {keepMembers ? (
            <div className="grid gap-1.5 sm:max-w-xs">
              <Label htmlFor="retention-member-months">Keep for (months)</Label>
              <Input
                id="retention-member-months"
                type="number"
                min={1}
                max={240}
                value={memberMonths}
                disabled={!canEdit}
                onChange={(e) => setMemberMonths(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                {monthsLabel(departedMonths ?? 24)} after they leave.
              </p>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              Retained indefinitely — you decide case by case using the erase action on each member.
            </p>
          )}
        </div>

        {/* Waivers — deliberately longer */}
        <div className="space-y-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-medium">Waivers, safety and incident records</div>
              <div className="text-xs text-muted-foreground">
                Kept on their own, longer clock, starting from the date each waiver was signed.
              </div>
            </div>
            <Switch checked={keepWaivers} onCheckedChange={setKeepWaivers} disabled={!canEdit} />
          </div>
          <p className="flex gap-2 text-xs text-muted-foreground">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
            <span>
              A signed waiver is your protection if a former member brings a personal injury claim,
              and those claims can be brought years after the event. Deleting waivers at the same
              time as member records could leave you undefended — that is why this period is separate
              and longer by default (7 years).
            </span>
          </p>
          {keepWaivers ? (
            <div className="grid gap-1.5 sm:max-w-xs">
              <Label htmlFor="retention-waiver-months">Keep for (months)</Label>
              <Input
                id="retention-waiver-months"
                type="number"
                min={1}
                max={480}
                value={waiverMonths}
                disabled={!canEdit}
                onChange={(e) => setWaiverMonths(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                {monthsLabel(waiverMonthsValue ?? 84)} after signing. The signature and guardian
                details are then removed; the fact a waiver was signed, its version and the date are
                kept.
              </p>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">Waivers are retained indefinitely.</p>
          )}
        </div>

        <div className="grid gap-1.5 sm:max-w-xs">
          <Label htmlFor="retention-notice">Notice before anonymising (days)</Label>
          <Input
            id="retention-notice"
            type="number"
            min={0}
            max={90}
            value={noticeDays}
            disabled={!canEdit}
            onChange={(e) => setNoticeDays(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            You get a task in the app this far ahead, so nothing disappears quietly.
          </p>
        </div>

        {canEdit && (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
              {save.isPending && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
              Save policy
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={run.isPending || !policy}
              onClick={() => run.mutate()}
            >
              {run.isPending && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
              Run now
            </Button>
          </div>
        )}

        {/* Scheduled — visible before anything happens */}
        <div className="space-y-3 rounded-lg border border-zinc-950/5 p-3">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Clock className="h-4 w-4" /> Scheduled for anonymisation
          </div>

          {scheduleLoading && <p className="text-xs text-muted-foreground">Checking…</p>}

          {!scheduleLoading && dueNow.length === 0 && dueSoon.length === 0 && blocked.length === 0 && (
            <p className="text-xs text-muted-foreground">
              Nothing is due. {schedule?.anonymisedCount ? `${schedule.anonymisedCount} record(s) already anonymised.` : ""}
            </p>
          )}

          {[
            { label: "Due on the next run", rows: dueNow, tone: "destructive" as const },
            { label: `Due within ${policy?.noticeDays ?? 14} days`, rows: dueSoon, tone: "secondary" as const },
            { label: "Kept back", rows: blocked, tone: "outline" as const },
          ]
            .filter((g) => g.rows.length > 0)
            .map((group) => (
              <div key={group.label} className="space-y-1.5">
                <div className="text-xs font-medium text-muted-foreground">{group.label}</div>
                {group.rows.map((m) => (
                  <div
                    key={m.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted/40 px-2.5 py-2"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm">{m.name}</div>
                      <div className="text-xs text-muted-foreground">
                        Left {fmtDate(m.departedAt)} · due {fmtDate(m.dueOn)}
                        {m.blockers.length > 0 && (
                          <>
                            {" · "}
                            {m.blockers
                              .map((b) => BLOCKER_LABELS[b as RetentionBlocker] ?? b)
                              .join(", ")}
                          </>
                        )}
                        {m.holdReason ? ` — ${m.holdReason}` : ""}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant={group.tone}>{m.blockers.includes("on_hold") ? "Excluded" : group.label}</Badge>
                      {canEdit && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            const nextHold = !m.blockers.includes("on_hold");
                            setHoldFor({ id: m.id, name: m.name, hold: nextHold });
                            setHoldReason("");
                          }}
                        >
                          {m.blockers.includes("on_hold") ? "Allow" : "Keep"}
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ))}

          {(schedule?.waiversDue ?? 0) > 0 && (
            <p className="text-xs text-muted-foreground">
              {schedule?.waiversDue} waiver(s) are past their retention period and will be scrubbed
              on the next run.
            </p>
          )}
        </div>

        {/* Audit */}
        {(history ?? []).length > 0 && (
          <div className="space-y-1.5 rounded-lg border border-zinc-950/5 p-3">
            <div className="text-sm font-medium">Recent runs</div>
            {(history ?? []).map((r) => (
              <div key={r.id} className="text-xs text-muted-foreground">
                {fmtDate(r.startedAt)} · {r.triggerSource} ·{" "}
                <span className={r.failures > 0 ? "text-destructive" : ""}>{r.status}</span> ·{" "}
                {r.membersAnonymised} anonymised, {r.membersSkipped} kept back, {r.waiversAnonymised}{" "}
                waivers
                {r.error ? ` · ${r.error}` : ""}
              </div>
            ))}
          </div>
        )}
      </CardContent>

      <Dialog open={!!holdFor} onOpenChange={(o) => !o && setHoldFor(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {holdFor?.hold ? "Keep this record" : "Allow anonymisation"}
            </DialogTitle>
            <DialogDescription>
              {holdFor?.hold
                ? `${holdFor?.name}'s record will be excluded from automatic anonymisation until you remove the exclusion. Record why — an ongoing dispute, an outstanding balance or a pending claim.`
                : `${holdFor?.name}'s record will be anonymised on the next run once it is past your retention period.`}
            </DialogDescription>
          </DialogHeader>
          {holdFor?.hold && (
            <Textarea
              value={holdReason}
              onChange={(e) => setHoldReason(e.target.value)}
              placeholder="e.g. Outstanding balance in collection / injury claim pending"
              rows={3}
            />
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setHoldFor(null)}>
              Cancel
            </Button>
            <Button
              disabled={hold.isPending || (holdFor?.hold === true && !holdReason.trim())}
              onClick={() => hold.mutate()}
            >
              {hold.isPending && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
              {holdFor?.hold ? "Keep record" : "Allow"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
