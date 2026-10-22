import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { trialPolicyLabel } from "@/lib/trial-policy";
import {
  getMembershipPolicy,
  updateMembershipPolicy,
} from "@/lib/membership-policy.functions";

/** Gym policy: notice before a price change, and access while paused. */
export function MembershipPolicyCard({ dojoId }: { dojoId: string }) {
  const qc = useQueryClient();
  const getFn = useServerFn(getMembershipPolicy);
  const saveFn = useServerFn(updateMembershipPolicy);

  const { data } = useQuery({
    queryKey: ["membership-policy", dojoId],
    enabled: !!dojoId,
    queryFn: () => getFn({ data: { dojoId } }),
  });

  const [days, setDays] = useState("30");
  const [canBook, setCanBook] = useState(false);
  const [noTrial, setNoTrial] = useState(false);
  const [length, setLength] = useState("7");
  const [unlimitedLength, setUnlimitedLength] = useState(false);
  const [perDay, setPerDay] = useState("1");
  const [capOn, setCapOn] = useState(false);
  const [cap, setCap] = useState("1");
  const [freeDays, setFreeDays] = useState("0");
  const [reminder, setReminder] = useState(true);

  useEffect(() => {
    if (data) {
      setDays(String(data.priceChangeNoticeDays));
      setCanBook(data.pausedMembersCanBook);
      const t = data.trial;
      setNoTrial(t.lengthDays === 0 || t.maxTotal === 0);
      setUnlimitedLength(t.lengthDays == null);
      setLength(String(t.lengthDays ?? 7));
      setPerDay(String(t.perDay));
      setCapOn(t.maxTotal != null && t.maxTotal > 0);
      setCap(String(t.maxTotal ?? 1));
      setFreeDays(String(data.signupFreeDays ?? 0));
      setReminder(data.trialReminderEnabled !== false);
    }
  }, [data]);

  const trialLengthDays = noTrial ? 0 : unlimitedLength ? null : Math.max(1, Math.round(Number(length) || 1));
  const trialClassesPerDay = Math.max(1, Math.round(Number(perDay) || 1));
  const trialMaxTotalClasses = noTrial ? null : capOn ? Math.max(1, Math.round(Number(cap) || 1)) : null;

  const signupFreeDays = Math.max(0, Math.round(Number(freeDays) || 0));

  const policy = { lengthDays: trialLengthDays, perDay: trialClassesPerDay, maxTotal: trialMaxTotalClasses };
  const label = trialPolicyLabel(policy);

  const save = useMutation({
    mutationFn: () =>
      saveFn({
        data: {
          dojoId,
          priceChangeNoticeDays: Math.round(Number(days) || 0),
          pausedMembersCanBook: canBook,
          trialLengthDays,
          trialClassesPerDay,
          trialMaxTotalClasses,
          signupFreeDays,
          trialReminderEnabled: reminder,
        },
      }),
    onSuccess: () => {
      toast.success("Policy saved");
      qc.invalidateQueries({ queryKey: ["membership-policy"] });
      qc.invalidateQueries({ queryKey: ["trial-usage"] });
      qc.invalidateQueries({ queryKey: ["my-trial-usage"] });
    },
    onError: (e: any) => toast.error(e?.message ?? "Could not save"),
  });

  const dirty =
    !!data &&
    (Math.round(Number(days) || 0) !== data.priceChangeNoticeDays ||
      canBook !== data.pausedMembersCanBook ||
      trialLengthDays !== data.trial.lengthDays ||
      trialClassesPerDay !== data.trial.perDay ||
      trialMaxTotalClasses !== data.trial.maxTotal ||
      signupFreeDays !== data.signupFreeDays ||
      reminder !== (data.trialReminderEnabled !== false));


  return (
    <div className="rounded-xl bg-card p-5 ring-1 ring-black/5">
      <h2 className="text-sm font-semibold">Trials, price changes &amp; pauses</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        How your free trial works, how much warning members get before their
        price changes, and what a paused member can still do.
      </p>

      <div className="mt-4 space-y-4">
        <div className="space-y-3 rounded-lg border border-zinc-950/5 p-3">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-medium">Offer a free trial</div>
              <div className="text-xs text-muted-foreground">
                {label ? `Shown on your signup page as "${label}".` : "No free trial is offered."}
              </div>
            </div>
            <Switch checked={!noTrial} onCheckedChange={(v) => setNoTrial(!v)} />
          </div>

          {!noTrial && (
            <div className="space-y-3">
              <div className="grid gap-1.5 sm:max-w-xs">
                <Label htmlFor="trial-length">Trial length (days)</Label>
                <Input
                  id="trial-length"
                  type="number"
                  min={1}
                  max={365}
                  value={unlimitedLength ? "" : length}
                  disabled={unlimitedLength}
                  onChange={(e) => setLength(e.target.value)}
                />
                <div className="flex items-center justify-between rounded-lg border border-zinc-950/5 px-3 py-2">
                  <div className="text-xs font-medium">No time limit</div>
                  <Switch checked={unlimitedLength} onCheckedChange={setUnlimitedLength} />
                </div>
                <p className="text-xs text-muted-foreground">
                  The clock starts on their first booked or attended class, not at signup — so
                  someone who signs up Monday and first trains Saturday still gets the full trial.
                </p>
              </div>

              <div className="grid gap-1.5 sm:max-w-xs">
                <Label htmlFor="trial-per-day">Classes per day</Label>
                <Input
                  id="trial-per-day"
                  type="number"
                  min={1}
                  max={10}
                  value={perDay}
                  onChange={(e) => setPerDay(e.target.value)}
                />
              </div>

              <div className="grid gap-1.5 sm:max-w-xs">
                <div className="flex items-center justify-between rounded-lg border border-zinc-950/5 px-3 py-2">
                  <div className="text-xs font-medium">Cap total trial classes</div>
                  <Switch checked={capOn} onCheckedChange={setCapOn} />
                </div>
                {capOn && (
                  <Input
                    type="number"
                    min={1}
                    max={200}
                    value={cap}
                    onChange={(e) => setCap(e.target.value)}
                  />
                )}
                <p className="text-xs text-muted-foreground">
                  Optional. Leave off for "one class a day for the whole trial".
                </p>
              </div>
            </div>
          )}
        </div>



        <div className="grid gap-1.5 sm:max-w-xs">
          <Label htmlFor="signup-free-days">Free days before the first payment</Label>
          <Input
            id="signup-free-days"
            type="number"
            min={0}
            max={90}
            value={freeDays}
            onChange={(e) => setFreeDays(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            0 means off. Set a number and everyone who joins must choose a plan and enter a
            card: they train with full access — no class limits — for that many days from
            signup, then their first payment is taken automatically. This replaces the
            free-trial-class option above on your signup page.
          </p>
        </div>

        <div className="flex items-center justify-between rounded-lg border border-zinc-950/5 px-3 py-2">
          <div>
            <div className="text-sm font-medium">Remind members before their first payment</div>
            <div className="text-xs text-muted-foreground">
              Email members before their free period ends and their first payment is taken.
              Turn this off if you tell members in person.
            </div>
          </div>
          <Switch checked={reminder} onCheckedChange={setReminder} />
        </div>

        <div className="grid gap-1.5 sm:max-w-xs">
          <Label htmlFor="notice-days">Notice before a price change (days)</Label>
          <Input
            id="notice-days"
            type="number"
            min={0}
            max={180}
            value={days}
            onChange={(e) => setDays(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            A price rise for existing members is scheduled this far ahead, and only
            takes effect at their next renewal after that.
          </p>
        </div>

        <div className="flex items-center justify-between rounded-lg border border-zinc-950/5 px-3 py-2">
          <div>
            <div className="text-sm font-medium">Paused members can book classes</div>
            <div className="text-xs text-muted-foreground">
              Off by default: a paused membership isn't billed, so booking is paused too.
            </div>
          </div>
          <Switch checked={canBook} onCheckedChange={setCanBook} />
        </div>

        <Button
          size="sm"
          className="bg-brand text-brand-foreground hover:bg-brand/90"
          disabled={!dirty || save.isPending}
          onClick={() => save.mutate()}
        >
          {save.isPending ? "Saving…" : "Save policy"}
        </Button>
      </div>
    </div>
  );
}
