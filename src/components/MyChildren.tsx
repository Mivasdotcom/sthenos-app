import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { listMyChildren, type MyChild } from "@/lib/my-children.functions";
import { createCheckoutSession } from "@/lib/payments.functions";
import { ageFromDob } from "@/lib/minors";

function money(cents: number, currency: string) {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: (currency || "eur").toUpperCase(),
  }).format(cents / 100);
}

function per(interval: string | null) {
  return interval === "year" ? "a year" : interval === "one_time" ? "one-off" : "a month";
}

/**
 * The children a member has added, and whether anyone is actually paying for
 * them. A child whose checkout didn't complete was previously invisible here:
 * on file, waivered, and unreachable without ringing the gym.
 */
export function MyChildren({ dojoId }: { dojoId: string }) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const listFn = useServerFn(listMyChildren);
  const checkoutFn = useServerFn(createCheckoutSession);

  const { data: children = [] } = useQuery({
    queryKey: ["my-children", dojoId],
    enabled: !!dojoId,
    queryFn: () => listFn({ data: { dojoId } }),
  });

  const pay = useMutation({
    mutationFn: async (child: MyChild) => {
      setBusyId(child.id);
      return checkoutFn({
        data: {
          dojoId,
          memberId: child.id,
          planId: child.planId!,
          returnPath: "/portal",
        },
      });
    },
    onSuccess: (out: any) => {
      setBusyId(null);
      if (out?.url) {
        window.location.href = out.url;
        return;
      }
      toast.error(out?.error ?? "Couldn't start payment. Please tell your gym.");
    },
    onError: (e: any) => {
      setBusyId(null);
      toast.error(e?.message ?? "Couldn't start payment. Please tell your gym.");
    },
  });

  if (children.length === 0) return null;

  return (
    <div className="mt-4 border-t border-zinc-950/5 pt-4">
      <div className="mb-2 flex items-center gap-2">
        <Users className="size-4 text-brand" />
        <h3 className="font-display text-sm font-medium">
          {children.length === 1 ? "My child" : "My children"}
        </h3>
      </div>

      <ul className="divide-y divide-zinc-950/5">
        {children.map((c) => {
          const age = ageFromDob(c.dateOfBirth);
          const needsPayment = !c.hasLiveSubscription;
          return (
            <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">{c.name}</span>
                  {needsPayment ? (
                    <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-900 ring-1 ring-amber-600/20">
                      Payment not set up
                    </span>
                  ) : (
                    <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-900 ring-1 ring-emerald-600/20">
                      Active
                    </span>
                  )}
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {age != null ? `${age} years old` : "Age not set"}
                  {c.planName ? ` · ${c.planName}` : ""}
                  {c.priceCents != null
                    ? ` · ${money(c.priceCents, c.currency ?? "eur")} ${per(c.interval)}`
                    : ""}
                </p>
              </div>

              {needsPayment && c.planId && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busyId === c.id}
                  onClick={() => pay.mutate(c)}
                >
                  {busyId === c.id ? "Opening…" : "Set up payment"}
                </Button>
              )}
            </li>
          );
        })}
      </ul>

      <p className="mt-3 text-xs text-muted-foreground">
        Each child has their own membership and is billed separately. Contact your gym to
        change or cancel one.
      </p>
    </div>
  );
}
