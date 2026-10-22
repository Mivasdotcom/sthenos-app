import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  addMembersToFamily,
  listFamilyGroups,
  listFamilyPayerCandidates,
  findFamilyGroupsByName,
} from "@/lib/family.functions";
import {
  getFamilyQuote,
  applyFamilyPricing,
  cancelCoveredMemberSubscription,
} from "@/lib/family-pricing.functions";
import { FamilyPricingBreakdown } from "@/components/FamilyPricingBreakdown";


const NEW_GROUP = "__new__";


export type FamilyTarget = { id: string; name: string };

/** Add one or many members to a family group — new or existing — with a payer. */
export function AddToFamilyDialog({
  dojoId,
  members,
  open,
  onOpenChange,
}: {
  dojoId: string | null;
  members: FamilyTarget[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const qc = useQueryClient();
  const listGroups = useServerFn(listFamilyGroups);
  const add = useServerFn(addMembersToFamily);

  const [groupId, setGroupId] = useState<string>(NEW_GROUP);
  const [name, setName] = useState("");
  const [payerId, setPayerId] = useState<string>("");
  const [ackIncrease, setAckIncrease] = useState(false);

  const groupsQ = useQuery({
    queryKey: ["family-groups", dojoId],
    enabled: !!dojoId && open,
    queryFn: () => listGroups({ data: { dojoId: dojoId! } }),
  });
  const groups = groupsQ.data?.groups ?? [];

  useEffect(() => {
    if (!open) return;
    setGroupId(NEW_GROUP);
    setPayerId(members.length === 1 ? members[0]!.id : "");
    setName(members.length === 1 ? `${members[0]!.name.split(" ").slice(-1)[0]} family` : "");
  }, [open, members]);

  const quoteFn = useServerFn(getFamilyQuote);
  const applyFn = useServerFn(applyFamilyPricing);
  const findByName = useServerFn(findFamilyGroupsByName);
  const memberIds = members.map((m) => m.id);

  const quoteQ = useQuery({
    queryKey: ["family-quote", dojoId, groupId, memberIds.join(","), payerId],
    enabled: !!dojoId && open && groupId !== NEW_GROUP,
    queryFn: () =>
      quoteFn({
        data: {
          dojoId: dojoId!,
          groupId,
          addMemberIds: memberIds,
          assumePayerId: payerId || null,
        },
      }),
  });
  const quote = quoteQ.data;
  // Steep tiers mean a change can make the payer pay MORE; that must be
  // explicitly acknowledged before it is applied.
  const increasesBill =
    !!quote?.next && quote.next.totalCents > (quote.current?.totalCents ?? 0);
  const existingPayer = groupId === NEW_GROUP ? null : (quote?.payer ?? null);
  const duplicates = (quote?.duplicateSubscriptions ?? []).filter(
    (d) => d.id !== payerId,
  );
  const methodConflicts = quote?.paymentMethodConflicts ?? [];

  // Case-insensitive duplicate-name check when creating a brand-new group.
  const nameMatchQ = useQuery({
    queryKey: ["family-name-match", dojoId, name.trim().toLowerCase()],
    enabled: !!dojoId && open && groupId === NEW_GROUP && name.trim().length > 1,
    queryFn: () => findByName({ data: { dojoId: dojoId!, name: name.trim() } }),
  });
  const nameMatches = groupId === NEW_GROUP ? (nameMatchQ.data?.matches ?? []) : [];


  const candidatesFn = useServerFn(listFamilyPayerCandidates);
  const candidatesQ = useQuery({
    queryKey: ["family-payer-candidates", dojoId, groupId, memberIds.join(",")],
    enabled: !!dojoId && open,
    queryFn: () =>
      candidatesFn({
        data: {
          dojoId: dojoId!,
          groupId: groupId === NEW_GROUP ? null : groupId,
          addMemberIds: memberIds,
        },
      }),
  });
  const payerOptions = candidatesQ.data?.candidates ?? [];

  useEffect(() => {
    if (existingPayer) setPayerId(existingPayer.id);
  }, [existingPayer]);

  const cancelDupFn = useServerFn(cancelCoveredMemberSubscription);
  const cancelDup = useMutation({
    mutationFn: (memberId: string) =>
      cancelDupFn({ data: { dojoId: dojoId!, memberId } }),
    onSuccess: () => {
      toast.success("That member's own subscription was cancelled.");
      qc.invalidateQueries({ queryKey: ["family-quote"] });
      qc.invalidateQueries({ queryKey: ["members"] });
    },
    onError: (e: Error) => toast.error(e.message ?? "Could not cancel that subscription"),
  });

  const mutation = useMutation({
    mutationFn: async () => {
      const res = await add({
        data: {
          dojoId: dojoId!,
          memberIds,
          groupId: groupId === NEW_GROUP ? null : groupId,
          newGroupName: groupId === NEW_GROUP ? name : null,
          payerId,
        },
      });
      // Push the recalculated family total onto the payer's subscription. The
      // amounts above are the confirmation; failures here are surfaced but must
      // not undo the grouping.
      const targetGroupId =
        groupId === NEW_GROUP ? ((res as any).groupId ?? null) : groupId;
      if (targetGroupId && quote?.mode === "tiered" && quote.next) {
        try {
          await applyFn({
            data: {
              dojoId: dojoId!,
              groupId: targetGroupId,
              expectedTotalCents: quote.next.totalCents,
            },
          });
        } catch (e: any) {
          toast.error(
            e?.message ?? "Members were grouped, but the family total could not be applied.",
          );
        }
      }
      return res;
    },
    onSuccess: (res) => {
      toast.success(
        `${res.count} ${res.count === 1 ? "member" : "members"} added to the family group`,
      );
      const switched = (res as any).cashSwitched as string[] | undefined;
      if (switched?.length) {
        toast.info(
          `${switched.join(", ")} now follow the payer's payment method and are no longer expected to pay separately.`,
        );
      }
      qc.invalidateQueries({ queryKey: ["members"] });
      qc.invalidateQueries({ queryKey: ["member-detail"] });
      qc.invalidateQueries({ queryKey: ["family-groups"] });
      qc.invalidateQueries({ queryKey: ["family-group-members"] });
      qc.invalidateQueries({ queryKey: ["family-quote"] });
      qc.invalidateQueries({ queryKey: ["family-coverage"] });
      qc.invalidateQueries({ queryKey: ["cash-dues"] });

      onOpenChange(false);
    },
    onError: (e: Error) => toast.error(e.message ?? "Could not update family group"),
  });


  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add to family</DialogTitle>
          <DialogDescription>
            {members.length === 1
              ? members[0]?.name
              : `${members.length} ${members.length === 1 ? "member" : "members"} selected`}
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!dojoId || mutation.isPending) return;
            if (!payerId) {
              toast.error("Choose the designated payer for this family.");
              return;
            }
            mutation.mutate();
          }}
        >
          <div className="space-y-1.5">
            <Label>Family group</Label>
            <Select value={groupId} onValueChange={setGroupId}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NEW_GROUP}>Create a new family group…</SelectItem>
                {groups.map((g) => (
                  <SelectItem key={g.id} value={g.id}>
                    {g.name}
                    {g.member_count
                      ? ` · ${g.member_count} ${g.member_count === 1 ? "member" : "members"}`
                      : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {groupId === NEW_GROUP && (
            <div className="space-y-1.5">
              <Label htmlFor="family-name">Family name</Label>
              <Input
                id="family-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. The Silva family"
                required
                maxLength={120}
              />
              {nameMatches.length > 0 && (
                <div className="space-y-2 rounded-md bg-amber-100 px-3 py-2 text-xs text-amber-900 ring-1 ring-inset ring-amber-500/30">
                  <p>
                    A family group called “{nameMatches[0]!.name}” already exists
                    {nameMatches[0]!.member_count
                      ? ` with ${nameMatches[0]!.member_count} ${nameMatches[0]!.member_count === 1 ? "member" : "members"}`
                      : ""}
                    . Join it instead of creating a duplicate.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {nameMatches.map((g) => (
                      <Button
                        key={g.id}
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-7 text-[11px]"
                        onClick={() => {
                          setGroupId(g.id);
                          setPayerId("");
                        }}
                      >
                        Join “{g.name}”
                      </Button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}


          <div className="space-y-1.5">
            <Label>
              Designated payer <span className="text-destructive">*</span>
            </Label>
            <Select
              value={payerId}
              onValueChange={setPayerId}
              disabled={!!existingPayer}
            >
              <SelectTrigger>
                <SelectValue placeholder="Choose the designated payer…" />
              </SelectTrigger>
              <SelectContent>
                {payerOptions.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.name}
                    {m.planName ? ` · ${m.planName}` : " · no plan"}
                    {m.isCurrentPayer ? " · current payer" : ""}
                    {!m.inGroup ? " · joining now" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">
              {existingPayer
                ? `${existingPayer.name} is this family's designated payer. To change who pays, use "Change payer" in the family section so the old subscription is cancelled first.`
                : "Exactly one member pays. Only the designated payer is charged; everyone else in the group is covered by that one payment and is never billed separately."}
            </p>
          </div>

          {(() => {
            const payer = payerOptions.find((p) => p.id === payerId);
            if (!payer) return null;
            const payerCash = payer.paymentMethod === "cash";
            const others = payerOptions.filter((p) => p.id !== payer.id).map((p) => p.name);
            return (
              <div className="space-y-1 rounded-md bg-zinc-50 px-3 py-2 text-xs text-zinc-700 ring-1 ring-inset ring-black/5">
                <div className="font-semibold text-foreground">
                  {payer.name} pays for the family · {payerCash ? "cash" : "card"}
                </div>
                <p>
                  {others.length > 0
                    ? `${others.join(", ")} will be covered by ${payer.name}'s ${payerCash ? "cash arrangement" : "card subscription"} and will no longer be expected to pay ${payerCash ? "on their own" : "cash"}.`
                    : `${payer.name} is billed the family total ${payerCash ? "in cash" : "by card"}.`}
                </p>
                {methodConflicts.length > 0 && (
                  <p>
                    {methodConflicts.map((c) => c.name).join(", ")}{" "}
                    {methodConflicts.length === 1 ? "currently pays" : "currently pay"} by{" "}
                    {methodConflicts[0]!.method === "cash" ? "cash" : "card"} separately — that is
                    replaced by the payer&apos;s method on confirming.
                  </p>
                )}
              </div>
            );
          })()}



          {duplicates.length > 0 && (
            <div className="space-y-2 rounded-md bg-amber-100 px-3 py-2 text-xs text-amber-900 ring-1 ring-inset ring-amber-500/30">
              <div className="font-semibold">
                Risk of double-charging
              </div>
              <p>
                {duplicates.map((d) => d.name).join(", ")}{" "}
                {duplicates.length === 1 ? "already has" : "already have"} their own active
                subscription. Cancel it so the family is only charged once through the payer.
              </p>
              <div className="flex flex-wrap gap-2">
                {duplicates.map((d) => (
                  <Button
                    key={d.id}
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-7 text-[11px]"
                    disabled={cancelDup.isPending}
                    onClick={() => cancelDup.mutate(d.id)}
                  >
                    Cancel {d.name}'s subscription
                  </Button>
                ))}
              </div>
            </div>
          )}

          {quote?.mode === "tiered" && quote.next && (
            <div className="space-y-2">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                What the payer will be charged
              </div>
              {quote.current.size > 0 && (
                <FamilyPricingBreakdown
                  quote={quote.current}
                  title="Before"
                  compact
                />
              )}
              <FamilyPricingBreakdown quote={quote.next} title="After this change" />
              {quote.tierDropWarning && (
                <div
                  className={
                    increasesBill
                      ? "rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs"
                      : "rounded-md bg-amber-100 px-3 py-2 text-xs text-amber-900 ring-1 ring-inset ring-amber-500/30"
                  }
                >
                  <p className={increasesBill ? "font-semibold text-foreground" : ""}>
                    {quote.tierDropWarning}
                  </p>
                  {increasesBill && (
                    <label className="mt-2 flex items-center gap-2 font-medium">
                      <input
                        type="checkbox"
                        checked={ackIncrease}
                        onChange={(e) => setAckIncrease(e.target.checked)}
                      />
                      I understand the payer will pay more
                    </label>
                  )}
                </div>
              )}
              <p className="text-[11px] text-muted-foreground">
                Confirming applies this total to the payer's subscription, prorated.
              </p>
            </div>
          )}



          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={mutation.isPending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={mutation.isPending || !payerId || (increasesBill && !ackIncrease)}
              className="bg-brand text-brand-foreground hover:bg-brand/90"
            >
              {mutation.isPending ? "Saving…" : "Add to family"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
